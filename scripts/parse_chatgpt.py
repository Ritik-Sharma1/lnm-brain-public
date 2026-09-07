#!/usr/bin/env python3
"""
ChatGPT Export Parser

Parses ChatGPT conversation export files (conversations-XXX.json) and converts them to markdown files.
Extracts entities, topics, and tags for the knowledge graph.

Usage:
    python3 scripts/parse_chatgpt.py /path/to/conversations-XXX.json
"""

import json
import sys
import os
from datetime import datetime
from pathlib import Path
import re

def parse_conversation(conversation):
    """Parse a single conversation and extract structured data."""
    title = conversation.get("title", "Untitled Conversation")
    create_time = conversation.get("create_time")
    update_time = conversation.get("update_time")

    # Format timestamps
    if create_time:
        date_str = datetime.fromtimestamp(create_time).strftime("%Y-%m-%d")
    else:
        date_str = "unknown"

    # Extract messages
    messages = []
    entities = set()
    topics = set()

    for msg in conversation.get("mapping", {}).values():
        if msg.get("message"):
            content = msg["message"].get("content", {})
            if isinstance(content, dict) and "parts" in content:
                text_parts = []
                for part in content["parts"]:
                    if isinstance(part, str):
                        text_parts.append(part)
                        # Extract entities (simple pattern matching)
                        entities.update(re.findall(r'\b[A-Z][a-z]+ [A-Z][a-z]+\b', part))
                        # Extract topics (hashtags, keywords)
                        topics.update(re.findall(r'\b(?:python|javascript|react|api|database|web|mobile|ai|ml|code|debug|fix|error)\b', part.lower()))

                if text_parts:
                    role = msg["message"].get("author", {}).get("role", "unknown")
                    messages.append({
                        "role": role,
                        "content": "\n".join(text_parts)
                    })

    # Build markdown content
    markdown = f"""# {title}

**Date**: {date_str}
**Source**: ChatGPT Export
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
    """Process a single ChatGPT export file."""
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
        print("Usage: python3 scripts/parse_chatgpt.py <conversations.json>")
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
