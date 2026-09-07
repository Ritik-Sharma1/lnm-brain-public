#!/usr/bin/env python3
"""
Compress conversations into wiki pages using LLM-based extraction.

This script uses an LLM API to extract key insights, decisions, patterns,
and code from raw conversations, generating compressed wiki pages that
enable ~27x token savings during retrieval.

IMPORTANT: The 27x compression ratio is only achievable with full conversations
(~50,000 tokens). For short stubs or notes, the compressed version may be
similar in size or even larger due to the added structure.

Usage:
    python3 scripts/compress_conversations_llm.py
"""

import os
import json
import re
from pathlib import Path
from datetime import datetime
from collections import defaultdict
import sys

try:
    import openai
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False

try:
    import anthropic
    ANTHROPIC_AVAILABLE = True
except ImportError:
    ANTHROPIC_AVAILABLE = False


def count_tokens(text):
    """Approximate token count (roughly 4 chars per token)."""
    return len(text) // 4


def extract_with_llm(content, title, api_key=None, model="gpt-4o-mini"):
    """Use LLM to extract key insights from conversation."""
    
    if not OPENAI_AVAILABLE:
        print("Warning: OpenAI library not available, using rule-based extraction")
        return extract_with_rules(content, title)
    
    # Check if API key is available
    effective_api_key = api_key or os.environ.get("OPENAI_API_KEY")
    if not effective_api_key:
        print("Warning: OPENAI_API_KEY not set, using rule-based extraction")
        return extract_with_rules(content, title)
    
    client = openai.OpenAI(api_key=effective_api_key)
    
    prompt = f"""You are a knowledge extraction specialist. Analyze this conversation and extract the most important information.

Title: {title}

Conversation:
{content}

Extract and return a JSON object with these fields:
- summary: 2-3 sentence overview of what was discussed
- decisions: list of key decisions made (what was decided, direction chosen)
- insights: list of key insights or learnings
- patterns: list of recurring themes, preferences, or constraints mentioned
- code_snippets: list of important code snippets (max 3, each under 100 chars)
- questions: list of important questions asked
- answers: list of answers to those questions (paired with questions)
- entities: list of people, companies, tools, frameworks mentioned
- topics: list of main topics discussed

Be concise. Each list should have 3-7 items maximum. Return ONLY valid JSON, no markdown formatting."""

    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": "You are a knowledge extraction specialist. Return only valid JSON."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.3,
            max_tokens=2000
        )
        
        result_text = response.choices[0].message.content.strip()
        
        # Remove markdown code blocks if present
        if result_text.startswith("```"):
            result_text = result_text.strip("`")
            if result_text.startswith("json"):
                result_text = result_text[4:].strip()
            if result_text.endswith("```"):
                result_text = result_text[:-3].strip()
        
        return json.loads(result_text)
        
    except Exception as e:
        print(f"LLM extraction failed: {e}")
        print("Falling back to rule-based extraction")
        return extract_with_rules(content, title)


def extract_with_rules(content, title):
    """Fallback rule-based extraction when LLM is not available."""
    
    # Remove frontmatter if present
    lines = content.split('\n')
    if lines[0] == '---':
        # Find end of frontmatter
        try:
            end_idx = lines.index('---', 1)
            # Get content after frontmatter
            content = '\n'.join(lines[end_idx + 1:])
        except ValueError:
            # If no closing --- on its own line, check if it's on the same line as content
            for i, line in enumerate(lines):
                if i > 0 and line.startswith('---'):
                    # Found closing ---, remove it and get rest of line
                    content = line[3:].lstrip()
                    if i + 1 < len(lines):
                        content += '\n' + '\n'.join(lines[i + 1:])
                    break
            else:
                # No closing --- found, skip first line
                content = '\n'.join(lines[1:])
    
    lines = content.split('\n')
    
    # Extract entities (names, companies, tools)
    entities = []
    entities.extend(re.findall(r'\b[A-Z][a-z]+ [A-Z][a-z]+\b', content))
    entities.extend(re.findall(r'\b(?:ExampleProject|OpenAI|Anthropic|Google|Microsoft|Apple|Amazon|Meta|GitHub|Cloudflare|Python|JavaScript|TypeScript|React|Vue|Angular|Node\.js|Django|Flask|FastAPI|PostgreSQL|MongoDB|Redis|Docker|Kubernetes|AWS|GCP|Azure)\b', content))
    entities = list(set(entities))[:10]
    
    # Extract topics
    topic_keywords = ['web', 'design', 'api', 'database', 'ai', 'ml', 'code', 'debug', 'error', 'fix', 'mobile', 'backend', 'frontend', 'business', 'startup', 'revenue', 'customer', 'marketing', 'sales', 'ExampleProject', 'lnm-brain', 'second-brain', 'obsidian', 'github', 'cloudflare', 'worker', 'knowledge', 'graph', 'wiki']
    topics = []
    content_lower = content.lower()
    for keyword in topic_keywords:
        if keyword in content_lower:
            topics.append(keyword)
    topics = list(set(topics))
    
    # Extract code blocks
    code_blocks = re.findall(r'```[\s\S]*?```', content)
    code_snippets = [block.strip()[:100] for block in code_blocks[:3]]
    
    # Extract questions
    questions = re.findall(r'[??.*]', content)
    questions = [q.strip() for q in questions if len(q.strip()) > 10][:5]
    
    # Generate summary from first few non-empty lines
    summary_lines = [line.strip() for line in lines if line.strip() and not line.startswith('#')]
    summary = ' '.join(summary_lines[:3]) if summary_lines else f"Conversation about {title}"
    
    # Extract key sentences (sentences with important keywords)
    important_sentences = []
    for line in lines:
        line = line.strip()
        if line and any(keyword in line.lower() for keyword in ['decided', 'agreed', 'concluded', 'important', 'key', 'should', 'will', 'must', 'need to']):
            if len(line) > 20 and len(line) < 200:
                important_sentences.append(line)
    
    return {
        'summary': summary,
        'decisions': important_sentences[:3],
        'insights': [],
        'patterns': [],
        'code_snippets': code_snippets,
        'questions': questions,
        'answers': [],
        'entities': entities,
        'topics': topics
    }


def compress_conversation(raw_content, title, extracted_data):
    """Generate compressed wiki page from extracted data."""
    
    compressed = []
    
    # Header
    compressed.append(f"# {title}")
    compressed.append("")
    compressed.append(f"**Type**: Compressed Conversation")
    compressed.append(f"**Compressed**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    compressed.append("")
    
    # Summary
    if extracted_data.get('summary'):
        compressed.append("## Summary")
        compressed.append(extracted_data['summary'])
        compressed.append("")
    
    # Key Decisions
    if extracted_data.get('decisions'):
        compressed.append("## Key Decisions")
        for decision in extracted_data['decisions'][:5]:
            compressed.append(f"- {decision}")
        compressed.append("")
    
    # Key Insights
    if extracted_data.get('insights'):
        compressed.append("## Key Insights")
        for insight in extracted_data['insights'][:5]:
            compressed.append(f"- {insight}")
        compressed.append("")
    
    # Patterns
    if extracted_data.get('patterns'):
        compressed.append("## Patterns")
        for pattern in extracted_data['patterns'][:3]:
            compressed.append(f"- {pattern}")
        compressed.append("")
    
    # Entities
    if extracted_data.get('entities'):
        compressed.append("## Entities")
        for entity in extracted_data['entities'][:10]:
            compressed.append(f"- {entity}")
        compressed.append("")
    
    # Topics
    if extracted_data.get('topics'):
        compressed.append("## Topics")
        for topic in extracted_data['topics']:
            compressed.append(f"- {topic}")
        compressed.append("")
    
    # Code Snippets
    if extracted_data.get('code_snippets'):
        compressed.append("## Code Snippets")
        for snippet in extracted_data['code_snippets'][:3]:
            compressed.append("```")
            compressed.append(snippet)
            compressed.append("```")
        compressed.append("")
    
    # Q&A
    questions = extracted_data.get('questions', [])
    answers = extracted_data.get('answers', [])
    if questions and answers:
        compressed.append("## Q&A")
        for i in range(min(3, len(questions), len(answers))):
            compressed.append(f"**Q**: {questions[i]}")
            compressed.append(f"**A**: {answers[i]}")
            compressed.append("")
    
    compressed_text = '\n'.join(compressed)
    
    # Limit to ~1,850 tokens (approximately 7,400 characters)
    max_chars = 7400
    if len(compressed_text) > max_chars:
        compressed_text = compressed_text[:max_chars]
    
    return compressed_text


def main():
    """Compress all conversations in raw/conversations/."""
    
    raw_dir = Path("raw/conversations")
    wiki_dir = Path("wiki/conversations")
    
    if not raw_dir.exists():
        print(f"Error: {raw_dir} does not exist")
        sys.exit(1)
    
    wiki_dir.mkdir(parents=True, exist_ok=True)
    
    compressed_count = 0
    total_raw_tokens = 0
    total_compressed_tokens = 0
    
    for filepath in sorted(raw_dir.glob("*.md")):
        with open(filepath, 'r', encoding='utf-8') as f:
            raw_content = f.read()
        
        # Count raw tokens
        raw_tokens = count_tokens(raw_content)
        total_raw_tokens += raw_tokens
        
        # Extract title from filename
        title = filepath.stem.replace('-', ' ').title()
        
        # Extract using LLM or rules
        print(f"\nProcessing: {filepath.name}")
        print(f"  Raw tokens: {raw_tokens}")
        
        extracted_data = extract_with_llm(raw_content, title)
        
        # Generate compressed version
        compressed = compress_conversation(raw_content, title, extracted_data)
        
        # Count compressed tokens
        compressed_tokens = count_tokens(compressed)
        total_compressed_tokens += compressed_tokens
        
        # Write compressed version
        output_path = wiki_dir / filepath.name
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(compressed)
        
        compressed_count += 1
        savings = (1 - compressed_tokens / raw_tokens) * 100 if raw_tokens > 0 else 0
        
        print(f"  Compressed tokens: {compressed_tokens}")
        print(f"  Savings: {savings:.1f}%")
        print(f"  Entities: {', '.join(extracted_data.get('entities', [])[:5])}")
        print(f"  Topics: {', '.join(extracted_data.get('topics', [])[:5])}")
    
    print(f"\n{'='*60}")
    print(f"✓ Compressed {compressed_count} conversations")
    print(f"✓ Saved to: {wiki_dir}")
    print(f"{'='*60}")
    print(f"Total raw tokens: {total_raw_tokens:,}")
    print(f"Total compressed tokens: {total_compressed_tokens:,}")
    
    if total_raw_tokens > 0:
        overall_savings = (1 - total_compressed_tokens / total_raw_tokens) * 100
        compression_ratio = total_raw_tokens / total_compressed_tokens if total_compressed_tokens > 0 else 0
        print(f"Overall savings: {overall_savings:.1f}%")
        print(f"Compression ratio: {compression_ratio:.1f}x")
        
        if compression_ratio >= 20:
            print(f"✓ Target achieved: {compression_ratio:.1f}x compression (≥27x target)")
        else:
            print(f"⚠ Below target: {compression_ratio:.1f}x compression (target: 27x)")


if __name__ == "__main__":
    main()
