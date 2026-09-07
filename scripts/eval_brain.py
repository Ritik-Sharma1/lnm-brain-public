#!/usr/bin/env python3
"""
Lnm-Brain eval harness — Upgrade 7.

Reads a golden set of (question, expected_substrings, category) from
meta/eval/golden-set.yaml, runs each through /ask, scores answers with an
LLM judge, writes a timestamped JSON report to meta/eval-history/.

Usage:
    export OPENROUTER_API_KEY=...      # or ANTHROPIC_API_KEY
    python3 eval_brain.py
    python3 eval_brain.py --quick      # 10 questions only
    python3 eval_brain.py --no-judge   # skip LLM judging (faithfulness scoring)

Outputs:
    meta/eval-history/YYYY-MM-DD-HH-MM.json
    Prints summary table to stdout.

Place this file at:    <repo-root>/scripts/eval_brain.py
Place golden set at:   <repo-root>/meta/eval/golden-set.yaml
Reports written to:    <repo-root>/meta/eval-history/
"""

from __future__ import annotations
import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:
    sys.stderr.write("pip install pyyaml\n")
    sys.exit(1)

# ---------- Config ----------

BRAIN_BASE = "https://your-worker-subdomain.workers.dev"
ASK_ENDPOINT = f"{BRAIN_BASE}/ask"
ASK_TIMEOUT = 60  # seconds — /ask can be slow on first call

REPO_ROOT = Path(__file__).resolve().parent.parent
GOLDEN_PATH = REPO_ROOT / "meta" / "eval" / "golden-set.yaml"
HISTORY_DIR = REPO_ROOT / "meta" / "eval-history"

# LLM judge — priority order:
#   1. Gemini CLI Worker proxy (Brain Owner's own, OpenAI-compatible, free via OAuth rotation)
#   2. OpenRouter ($)
#   3. Anthropic direct ($)
GEMINI_PROXY_URL = "https://your-gemini-proxy-worker.workers.dev/v1/chat/completions"
JUDGE_MODEL_GEMINI = "gemini-2.5-flash"  # cheap+fast; bump to gemini-3.1-pro for premium runs
JUDGE_MODEL_OR = "anthropic/claude-sonnet-4.6"
JUDGE_MODEL_ANT = "claude-sonnet-4-6"


@dataclass
class Question:
    id: str
    category: str           # episodic | semantic | procedural | multi-hop | negative
    question: str
    expected_substrings: list[str]   # ALL must appear in answer for substring score
    expected_no_answer: bool = False  # True for negatives — model should refuse
    notes: str = ""


@dataclass
class Result:
    id: str
    category: str
    question: str
    answer: str
    confidence: float | None
    critique: dict[str, Any] | None
    search_method: str | None
    sources: list[dict[str, Any]]
    latency_ms: int
    substring_score: float        # fraction of expected_substrings found, 0-1
    judge_score: float | None     # 0-1, LLM-graded, None if no-judge
    judge_reason: str | None
    error: str | None


# ---------- HTTP ----------

def post_json(url: str, payload: dict, timeout: int = 30) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST",
                                  headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def call_brain(question: str, top_k: int = 5) -> tuple[dict, int]:
    t0 = time.time()
    try:
        data = post_json(ASK_ENDPOINT, {"question": question, "top_k": top_k}, ASK_TIMEOUT)
        return data, int((time.time() - t0) * 1000)
    except (urllib.error.URLError, TimeoutError) as e:
        return {"error": str(e), "answer": ""}, int((time.time() - t0) * 1000)


# ---------- Scoring ----------

def substring_score(answer: str, expected: list[str], expected_no_answer: bool) -> float:
    """Fraction of expected substrings present in answer (case-insensitive)."""
    if expected_no_answer:
        # Negative: refusal indicators count as correct
        refuse_markers = ["i don't know", "no relevant", "not found", "no information",
                          "couldn't find", "do not have", "nothing about"]
        a = answer.lower()
        return 1.0 if any(m in a for m in refuse_markers) else 0.0
    if not expected:
        return 1.0
    a = answer.lower()
    hits = sum(1 for s in expected if s.lower() in a)
    return hits / len(expected)


# ---------- LLM judge ----------

JUDGE_PROMPT = """You grade an answer against expected criteria. Output ONLY JSON.

Question: {question}
Expected substrings (the answer should contain these or their meaning): {expected}
Should refuse: {refuse}

Answer to grade:
{answer}

Score 0.0-1.0 on:
- faithfulness: does the answer stay within the retrieved context (no hallucination)?
- relevance: does it actually address the question?
- completeness: are the expected points covered?

Output: {{"score": <0.0-1.0 weighted avg>, "reason": "<one short sentence>"}}"""


def judge_with_gemini_proxy(q: Question, answer: str) -> tuple[float, str] | None:
    """Use Brain Owner's own gemini-cli-worker (OpenAI-compatible, no API key needed,
    OAuth multi-account rotation against Google free tier)."""
    prompt = JUDGE_PROMPT.format(
        question=q.question,
        expected=q.expected_substrings,
        refuse=q.expected_no_answer,
        answer=answer[:3000],
    )
    payload = {
        "model": JUDGE_MODEL_GEMINI,
        "stream": False,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 200,
    }
    try:
        req = urllib.request.Request(
            GEMINI_PROXY_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "content-type": "application/json",
                "user-agent": "lnm-brain-eval/0.1 (+python urllib)",
            },
        )
        with urllib.request.urlopen(req, timeout=90) as r:
            data = json.loads(r.read().decode("utf-8"))
        text = data["choices"][0]["message"]["content"]
        import re
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            return None
        parsed = json.loads(m.group(0))
        return float(parsed.get("score", 0)), str(parsed.get("reason", ""))[:200]
    except Exception as e:
        sys.stderr.write(f"judge Gemini-proxy failed: {e}\n")
        return None


def judge_with_openrouter(q: Question, answer: str) -> tuple[float, str] | None:
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        return None
    prompt = JUDGE_PROMPT.format(
        question=q.question,
        expected=q.expected_substrings,
        refuse=q.expected_no_answer,
        answer=answer[:3000],
    )
    payload = {
        "model": JUDGE_MODEL_OR,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 200,
    }
    try:
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "authorization": f"Bearer {key}",
                "content-type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=45) as r:
            data = json.loads(r.read().decode("utf-8"))
        text = data["choices"][0]["message"]["content"]
        # Extract JSON
        import re
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            return None
        parsed = json.loads(m.group(0))
        return float(parsed.get("score", 0)), str(parsed.get("reason", ""))[:200]
    except Exception as e:
        sys.stderr.write(f"judge OR failed: {e}\n")
        return None


def judge_with_anthropic(q: Question, answer: str) -> tuple[float, str] | None:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    prompt = JUDGE_PROMPT.format(
        question=q.question,
        expected=q.expected_substrings,
        refuse=q.expected_no_answer,
        answer=answer[:3000],
    )
    payload = {
        "model": JUDGE_MODEL_ANT,
        "max_tokens": 200,
        "messages": [{"role": "user", "content": prompt}],
    }
    try:
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=45) as r:
            data = json.loads(r.read().decode("utf-8"))
        text = data["content"][0]["text"]
        import re
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            return None
        parsed = json.loads(m.group(0))
        return float(parsed.get("score", 0)), str(parsed.get("reason", ""))[:200]
    except Exception as e:
        sys.stderr.write(f"judge Anthropic failed: {e}\n")
        return None


def llm_judge(q: Question, answer: str) -> tuple[float, str] | None:
    # Priority: free Gemini proxy first, then paid fallbacks.
    return (
        judge_with_gemini_proxy(q, answer)
        or judge_with_openrouter(q, answer)
        or judge_with_anthropic(q, answer)
    )


# ---------- Runner ----------

def load_golden_set(path: Path) -> list[Question]:
    if not path.exists():
        sys.stderr.write(f"Golden set missing: {path}\nCreate it from the template first.\n")
        sys.exit(2)
    raw = yaml.safe_load(path.read_text())
    qs = []
    for i, item in enumerate(raw.get("questions", [])):
        qs.append(Question(
            id=item.get("id") or f"q{i+1:03d}",
            category=item.get("category", "episodic"),
            question=item["question"],
            expected_substrings=item.get("expected_substrings", []) or [],
            expected_no_answer=bool(item.get("expected_no_answer", False)),
            notes=item.get("notes", "") or "",
        ))
    return qs


def run_one(q: Question, use_judge: bool) -> Result:
    resp, latency = call_brain(q.question)
    if "error" in resp:
        return Result(
            id=q.id, category=q.category, question=q.question,
            answer="", confidence=None, critique=None, search_method=None,
            sources=[], latency_ms=latency,
            substring_score=0.0, judge_score=None, judge_reason=None,
            error=resp["error"],
        )

    answer = resp.get("answer", "") or ""
    sub_score = substring_score(answer, q.expected_substrings, q.expected_no_answer)

    judge_score: float | None = None
    judge_reason: str | None = None
    if use_judge:
        j = llm_judge(q, answer)
        if j:
            judge_score, judge_reason = j

    return Result(
        id=q.id, category=q.category, question=q.question,
        answer=answer,
        confidence=resp.get("confidence"),
        critique=resp.get("critique"),
        search_method=resp.get("search_method"),
        sources=(resp.get("sources") or [])[:5],
        latency_ms=latency,
        substring_score=sub_score,
        judge_score=judge_score,
        judge_reason=judge_reason,
        error=None,
    )


def summarise(results: list[Result]) -> dict:
    by_cat: dict[str, list[Result]] = {}
    for r in results:
        by_cat.setdefault(r.category, []).append(r)

    def avg(xs):
        xs = [x for x in xs if x is not None]
        return round(sum(xs) / len(xs), 3) if xs else None

    summary = {
        "total": len(results),
        "errors": sum(1 for r in results if r.error),
        "avg_latency_ms": int(avg([r.latency_ms for r in results]) or 0),
        "substring_score": avg([r.substring_score for r in results]),
        "judge_score": avg([r.judge_score for r in results]),
        "confidence_avg": avg([r.confidence for r in results]),
        "per_category": {},
    }
    for cat, rs in sorted(by_cat.items()):
        summary["per_category"][cat] = {
            "n": len(rs),
            "substring": avg([r.substring_score for r in rs]),
            "judge": avg([r.judge_score for r in rs]),
            "confidence": avg([r.confidence for r in rs]),
        }
    return summary


def print_summary(summary: dict, results: list[Result]) -> None:
    print()
    print(f"=== Lnm-Brain eval — {summary['total']} questions ===")
    print(f"errors        : {summary['errors']}")
    print(f"avg latency   : {summary['avg_latency_ms']} ms")
    print(f"substring     : {summary['substring_score']}")
    print(f"judge         : {summary['judge_score']}")
    print(f"confidence    : {summary['confidence_avg']}")
    print()
    print(f"{'category':<14} {'n':>3} {'subs':>6} {'judge':>6} {'conf':>6}")
    print("-" * 42)
    for cat, c in summary["per_category"].items():
        print(f"{cat:<14} {c['n']:>3} {str(c['substring']):>6} {str(c['judge']):>6} {str(c['confidence']):>6}")
    print()
    fails = [r for r in results if r.substring_score < 0.5 and not r.error]
    if fails:
        print(f"Bottom {min(5, len(fails))} substring fails:")
        for r in sorted(fails, key=lambda x: x.substring_score)[:5]:
            print(f"  [{r.id}] {r.category} — {r.substring_score:.2f}  {r.question[:70]}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="first 10 only")
    ap.add_argument("--no-judge", action="store_true", help="skip LLM judging")
    ap.add_argument("--golden", type=Path, default=GOLDEN_PATH)
    ap.add_argument("--out-dir", type=Path, default=HISTORY_DIR)
    ap.add_argument("--category", type=str, help="filter to one category")
    args = ap.parse_args()

    questions = load_golden_set(args.golden)
    if args.category:
        questions = [q for q in questions if q.category == args.category]
    if args.quick:
        questions = questions[:10]
    if not questions:
        sys.stderr.write("No questions to run.\n")
        return 1

    print(f"Running {len(questions)} questions against {BRAIN_BASE} ...")
    use_judge = not args.no_judge
    # Gemini proxy (Brain Owner's own worker) is the default judge — no API key needed.
    # Only skip if user explicitly passes --no-judge.
    if use_judge:
        print(f"  judge: gemini-cli-worker proxy ({JUDGE_MODEL_GEMINI})"
              + (" with OpenRouter/Anthropic fallback" if (os.environ.get("OPENROUTER_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")) else ""))

    results: list[Result] = []
    for i, q in enumerate(questions, 1):
        print(f"  [{i:>3}/{len(questions)}] {q.category:<10} {q.id}", end=" ", flush=True)
        r = run_one(q, use_judge)
        results.append(r)
        flag = "OK"
        if r.error: flag = f"ERR ({r.error[:30]})"
        elif r.substring_score < 0.5: flag = f"WEAK {r.substring_score:.2f}"
        print(f"{r.latency_ms:>4}ms  {flag}")

    summary = summarise(results)
    print_summary(summary, results)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d-%H-%M")
    out_path = args.out_dir / f"{stamp}.json"
    out_path.write_text(json.dumps({
        "timestamp": stamp,
        "brain_base": BRAIN_BASE,
        "summary": summary,
        "results": [asdict(r) for r in results],
    }, indent=2))
    print(f"Wrote {out_path}")
    return 0 if summary["errors"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
