#!/usr/bin/env python3
"""
Claude Export Parser

Parses Claude conversation export file (conversations.json) and converts them to markdown files.
Extracts entities, topics, and tags for the knowledge graph.

Usage:
    python3 scripts/parse_claude.py /path/to/conversations.json
"""

import json
import sys
import os
from datetime import datetime
from pathlib import Path
import re

def parse_conversation(conversation):
    """Parse a single Claude conversation and extract structured data."""
    title = conversation.get("name", "Untitled Conversation")
    created_at = conversation.get("created_at")

    # Format timestamp
    if created_at:
        try:
            date_str = datetime.fromisoformat(created_at.replace('Z', '+00:00')).strftime("%Y-%m-%d")
        except:
            date_str = "unknown"
    else:
        date_str = "unknown"

    # Extract messages
    messages = []
    entities = set()
    topics = set()

    for msg in conversation.get("messages", []):
        content = msg.get("content", [])

        # Handle different content formats
        text_content = ""
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and "text" in part:
                    text_content += part["text"]
                elif isinstance(part, str):
                    text_content += part
        elif isinstance(content, str):
            text_content = content

        if text_content:
            role = msg.get("role", "unknown")

            # Extract entities (names, emails, URLs)
            entities.update(re.findall(r'\b[A-Z][a-z]+ [A-Z][a-z]+\b', text_content))
            entities.update(re.findall(r'\b[\w.-]+@[\w.-]+\.\w+\b', text_content))

            # Extract topics (keywords)
            topics.update(re.findall(r'\b(?:python|javascript|react|api|database|web|mobile|ai|ml|code|debug|fix|error|claude|openai|llm|prompt)\b', text_content.lower()))

            messages.append({
                "role": role,
                "content": text_content
            })

    # Build markdown content
    markdown = f"""# {title}

**Date**: {date_str}
**Source**: Claude Export
**Message Count**: {len(messages)}

## Conversation

"""

    for msg in messages:
        role_emoji = "👤" if msg["role"] == "user" else "🤖"
        markdown += f"\n### {role_emoji} {msg['role'].title()}\n\n{msg['content']}\n"

    # Extract tags from topics
    tags = list(topics)[:10]  # Limit to top 10 tags

    return {
        "title": title,
        "date": date_str,
        "content": markdown,
        "tags": tags,
        "entities": list(entities)[:20],  # Limit to top 20 entities
        "message_count": len(messages)
    }

def process_export_file(file_path, output_dir="raw/conversations"):
    """Process a single Claude export file."""
    print(f"Processing {file_path}...")

    with open(file_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # Create output directory
    os.makedirs(output_dir, exist_ok=True)

    results = []

    # Process each conversation
    for conv in data:
        parsed = parse_conversation(conv)

        # Generate filename
        safe_title = re.sub(r'[^\w\s-]', '', parsed["title"]).strip()
        safe_title = re.sub(r'[-\s]+', '-', safe_title)
        filename = f"{parsed['date']}-{safe_title.lower()}.md"
        filepath = os.path.join(output_dir, filename)

        # Write markdown file
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(parsed["content"])

        results.append({
            "filepath": filepath,
            "title": parsed["title"],
            "tags": parsed["tags"],
            "entities": parsed["entities"]
        })

        print(f"  ✓ Created: {filename}")

    return results

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/parse_claude.py <conversations.json>")
        sys.exit(1)

    export_file = sys.argv[1]

    if not os.path.exists(export_file):
        print(f"Error: File not found: {export_file}")
        sys.exit(1)

    results = process_export_file(export_file)

    print(f"\n✓ Processed {len(results)} conversations")
    print(f"\nNext steps:")
    print(f"1. Review the generated markdown files in raw/conversations/")
    print(f"2. Run the tagging/linking script to create wikilinks")
    print(f"3. Post to Capture API to add to knowledge graph")

if __name__ == "__main__":
    main()
