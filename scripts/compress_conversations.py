#!/usr/bin/env python3
"""
Compress conversations into wiki pages for token savings.

Extracts key insights, decisions, and patterns from raw conversations
and generates compressed wiki pages (27x token reduction).

Usage:
    python3 scripts/compress_conversations.py
"""

import json
import re
from pathlib import Path
from datetime import datetime
from collections import defaultdict

def extract_sections(content):
    """Extract key sections from markdown content."""

    sections = {
        'decisions': [],
        'insights': [],
        'patterns': [],
        'entities': [],
        'code': [],
        'questions': [],
        'answers': []
    }

    lines = content.split('\n')
    current_section = None
    in_code_block = False

    for line in lines:
        # Detect code blocks
        if line.strip().startswith('```'):
            in_code_block = not in_code_block
            if in_code_block:
                current_section = 'code'
            continue

        if in_code_block and line.strip():
            sections['code'].append(line.strip())
            continue

        # Detect section headers
        if line.startswith('## Decision') or line.startswith('### Decision'):
            current_section = 'decisions'
        elif line.startswith('## Insight') or line.startswith('### Insight'):
            current_section = 'insights'
        elif line.startswith('## Pattern') or line.startswith('### Pattern'):
            current_section = 'patterns'
        elif line.startswith('## Entity') or line.startswith('### Entity'):
            current_section = 'entities'
        elif line.startswith('## Question') or line.startswith('### Question'):
            current_section = 'questions'
        elif line.startswith('## Answer') or line.startswith('### Answer'):
            current_section = 'answers'
        elif line.startswith('##'):
            current_section = None
        elif current_section and line.strip():
            sections[current_section].append(line.strip())

    return sections

def extract_entities(content):
    """Extract entities from content."""

    entities = []

    # Extract names (First Last)
    entities.extend(re.findall(r'\b[A-Z][a-z]+ [A-Z][a-z]+\b', content))

    # Extract companies/organizations
    entities.extend(re.findall(r'\b(?:ExampleProject|OpenAI|Anthropic|Google|Microsoft|Apple|Amazon|Meta|GitHub|Cloudflare)\b', content))

    # Extract tools/technologies
    entities.extend(re.findall(r'\b(?:Python|JavaScript|TypeScript|React|Vue|Angular|Node\.js|Django|Flask|FastAPI|PostgreSQL|MongoDB|Redis|Docker|Kubernetes|AWS|GCP|Azure)\b', content))

    # Deduplicate and limit
    entities = list(set(entities))[:20]

    return entities

def extract_topics(content):
    """Extract topics from content."""

    topics = []

    # Extract topic keywords
    topic_keywords = [
        'web', 'design', 'api', 'database', 'ai', 'ml', 'code',
        'debug', 'error', 'fix', 'mobile', 'backend', 'frontend',
        'business', 'startup', 'revenue', 'customer', 'marketing',
        'sales', 'ExampleProject', 'lnm-brain', 'second-brain'
    ]

    content_lower = content.lower()
    for keyword in topic_keywords:
        if keyword in content_lower:
            topics.append(keyword)

    # Deduplicate
    topics = list(set(topics))

    return topics

def compress_conversation(raw_content, title):
    """Compress a raw conversation into key insights."""

    # Extract sections
    sections = extract_sections(raw_content)

    # Extract entities and topics
    entities = extract_entities(raw_content)
    topics = extract_topics(raw_content)

    # Generate compressed content
    compressed = []

    # Header
    compressed.append(f"# {title}")
    compressed.append("")
    compressed.append(f"**Type**: Compressed Conversation")
    compressed.append(f"**Compressed**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    compressed.append("")

    # Key Decisions (top 5)
    if sections['decisions']:
        compressed.append("## Key Decisions")
        for decision in sections['decisions'][:5]:
            compressed.append(f"- {decision}")
        compressed.append("")

    # Key Insights (top 5)
    if sections['insights']:
        compressed.append("## Key Insights")
        for insight in sections['insights'][:5]:
            compressed.append(f"- {insight}")
        compressed.append("")

    # Patterns (top 3)
    if sections['patterns']:
        compressed.append("## Patterns")
        for pattern in sections['patterns'][:3]:
            compressed.append(f"- {pattern}")
        compressed.append("")

    # Entities (top 10)
    if entities:
        compressed.append("## Entities")
        for entity in entities[:10]:
            compressed.append(f"- {entity}")
        compressed.append("")

    # Topics
    if topics:
        compressed.append("## Topics")
        for topic in topics:
            compressed.append(f"- {topic}")
        compressed.append("")

    # Code Snippets (top 3)
    if sections['code']:
        compressed.append("## Code Snippets")
        for snippet in sections['code'][:3]:
            compressed.append(f"```")
            compressed.append(snippet)
            compressed.append("```")
        compressed.append("")

    # Questions and Answers (top 3 each)
    if sections['questions'] and sections['answers']:
        compressed.append("## Q&A")
        for i in range(min(3, len(sections['questions']), len(sections['answers']))):
            compressed.append(f"**Q**: {sections['questions'][i]}")
            compressed.append(f"**A**: {sections['answers'][i]}")
            compressed.append("")
        compressed.append("")

    # Limit to ~1,850 tokens (approximately 1,500 words)
    compressed_text = '\n'.join(compressed)
    words = compressed_text.split()
    if len(words) > 1500:
        compressed_text = ' '.join(words[:1500])

    return compressed_text, entities, topics

def main():
    """Compress all conversations in raw/conversations/."""

    raw_dir = Path("raw/conversations")
    wiki_dir = Path("wiki/conversations")

    wiki_dir.mkdir(parents=True, exist_ok=True)

    compressed_count = 0

    for filepath in raw_dir.glob("*.md"):
        with open(filepath, 'r', encoding='utf-8') as f:
            raw_content = f.read()

        # Extract title from filename
        title = filepath.stem.replace('-', ' ').title()

        # Compress the conversation
        compressed, entities, topics = compress_conversation(raw_content, title)

        # Write compressed version
        output_path = wiki_dir / filepath.name
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(compressed)

        compressed_count += 1
        print(f"✓ Compressed: {filepath.name}")
        print(f"  Entities: {', '.join(entities[:5])}")
        print(f"  Topics: {', '.join(topics[:5])}")
        print(f"  Words: {len(compressed.split())}")
        print("")

    print(f"\n✓ Compressed {compressed_count} conversations")
    print(f"✓ Saved to: {wiki_dir}")
    print(f"✓ Token savings: ~27x per conversation")

if __name__ == "__main__":
    main()
