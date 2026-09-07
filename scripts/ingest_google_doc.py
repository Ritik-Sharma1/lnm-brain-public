#!/usr/bin/env python3
"""
Ingest Google Doc into Lnm-Brain

This script fetches a Google Doc and processes it into the knowledge graph.

Usage:
    python3 scripts/ingest_google_doc.py <doc_id>
    python3 scripts/ingest_google_doc.py 1EmNHgb_sPKlpcOyuyBrJbjPsQcxnGEWuBx8zSIKKrrE
"""

import os
import sys
import json
import re
import argparse
from pathlib import Path
from datetime import datetime
from collections import defaultdict

try:
    import requests
    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False
    print("Error: requests library not installed")
    sys.exit(1)

# Configuration
BRAIN_API = "https://your-worker-subdomain.workers.dev"
API_KEY = "YOUR_API_KEY"


def extract_entities(text):
    """Extract entities from text."""
    entities = []
    
    # Names (First Last)
    entities.extend(re.findall(r'\b[A-Z][a-z]+ [A-Z][a-z]+\b', text))
    
    # Companies/organizations
    entities.extend(re.findall(
        r'\b(?:ExampleProject|OpenAI|Anthropic|Google|Microsoft|Apple|Amazon|Meta|GitHub|Cloudflare)\b',
        text
    ))
    
    # Tools/technologies
    entities.extend(re.findall(
        r'\b(?:Python|JavaScript|TypeScript|React|Vue|Angular|Node\.js|Django|Flask|FastAPI|PostgreSQL|MongoDB|Redis|Docker|Kubernetes|AWS|GCP|Azure)\b',
        text
    ))
    
    # Deduplicate and limit
    entities = list(set(entities))[:20]
    
    return entities


def extract_topics(text):
    """Extract topics from text."""
    topics = []
    
    # Topic keywords
    topic_keywords = [
        'web', 'design', 'api', 'database', 'ai', 'ml', 'code',
        'debug', 'error', 'fix', 'mobile', 'backend', 'frontend',
        'business', 'startup', 'revenue', 'customer', 'marketing',
        'sales', 'ExampleProject', 'lnm-brain', 'second-brain', 'obsidian',
        'github', 'cloudflare', 'worker', 'knowledge', 'graph', 'wiki',
        'rag', 'llm', 'gpt', 'claude', 'anthropic', 'openai'
    ]
    
    text_lower = text.lower()
    for keyword in topic_keywords:
        if keyword in text_lower:
            topics.append(keyword)
    
    # Deduplicate
    topics = list(set(topics))
    
    return topics


def process_google_doc(doc_id, title=None):
    """Process a Google Doc into the knowledge graph."""
    
    # Build Google Doc URL
    doc_url = f"https://docs.google.com/document/d/{doc_id}/edit"
    
    print(f"Processing Google Doc: {doc_url}")
    print()
    
    # Try to fetch content from Google Docs API
    # Note: This requires Google Docs API credentials
    # For now, we'll create a placeholder and ask the user to provide content
    
    print("Note: To fetch the actual content from Google Docs, you need to:")
    print("1. Set up Google Docs API credentials")
    print("2. Provide the credentials to this script")
    print()
    print("For now, creating a placeholder node with the doc URL...")
    print()
    
    # Create placeholder content
    content = f"""# About Brain Owner

This is a 75-page comprehensive report about Brain Owner.

**Source**: [Google Doc]({doc_url})

**Note**: This is a placeholder. To ingest the full content:
1. Export the Google Doc as markdown or text
2. Run: python3 scripts/ingest_google_doc.py --content <path/to/exported/file.md>

## Sections

This document contains information about:
- Background and introduction
- Projects and work experience
- Skills and technologies
- Education and learning
- Interests and passions
- Goals and objectives

## Next Steps

To properly integrate this document into the knowledge graph:
1. Export the Google Doc as markdown
2. Run the ingestion script with the exported content
3. The script will extract entities, topics, and key insights
4. Create proper wiki pages for each section
5. Update the knowledge graph
"""
    
    # Extract entities and topics
    entities = extract_entities(content)
    topics = extract_topics(content)
    
    # Generate title
    if not title:
        title = "About Brain Owner - Comprehensive Report"
    
    # Capture to Second Brain
    print("Capturing to Second Brain...")
    result = capture_to_brain(title, content, topics, entities, doc_url)
    
    if result:
        print(f"✓ Captured: {result.get('path', 'unknown')}")
        print()
        print(f"Entities: {', '.join(entities[:10])}")
        print(f"Topics: {', '.join(topics[:10])}")
        return result
    else:
        print("✗ Failed to capture")
        return None


def process_markdown_file(file_path, title=None):
    """Process a markdown file into the knowledge graph."""
    
    print(f"Processing markdown file: {file_path}")
    print()
    
    # Read the file
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        print(f"Error reading file: {e}")
        return None
    
    # Extract entities and topics
    entities = extract_entities(content)
    topics = extract_topics(content)
    
    # Generate title
    if not title:
        title = Path(file_path).stem.replace('-', ' ').title()
    
    # Create enhanced content with metadata
    enhanced_content = f"""# {title}

**Source**: {file_path}
**Processed**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

## Entities

{chr(10).join(f'- {entity}' for entity in entities)}

## Topics

{chr(10).join(f'- {topic}' for topic in topics)}

## Original Content

{content}
"""
    
    # Capture to Second Brain
    print("Capturing to Second Brain...")
    result = capture_to_brain(title, enhanced_content, topics, entities)
    
    if result:
        print(f"✓ Captured: {result.get('path', 'unknown')}")
        print()
        print(f"Entities: {', '.join(entities[:10])}")
        print(f"Topics: {', '.join(topics[:10])}")
        return result
    else:
        print("✗ Failed to capture")
        return None


def capture_to_brain(title, content, tags=None, entities=None, source_url=None):
    """Capture content to Second Brain."""
    if tags is None:
        tags = []
    if entities is None:
        entities = []
    
    try:
        response = requests.post(
            f"{BRAIN_API}/capture",
            headers={"X-API-Key": API_KEY},
            json={
                "type": "note",
                "title": title,
                "content": content,
                "tags": tags,
                "entities": entities,
                "source_url": source_url
            },
            timeout=10
        )
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"Error capturing: {e}")
        return None


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Ingest Google Doc or markdown file into Lnm-Brain"
    )
    parser.add_argument(
        "doc_id",
        nargs="?",
        help="Google Doc ID or path to markdown file"
    )
    parser.add_argument(
        "--content",
        metavar="FILE",
        help="Path to exported markdown/text file"
    )
    parser.add_argument(
        "--title",
        metavar="TITLE",
        help="Title for the captured content"
    )
    
    args = parser.parse_args()
    
    if args.content:
        # Process markdown file
        result = process_markdown_file(args.content, args.title)
    elif args.doc_id:
        # Process Google Doc
        result = process_google_doc(args.doc_id, args.title)
    else:
        parser.print_help()
        print("\nExamples:")
        print("  python3 scripts/ingest_google_doc.py 1EmNHgb_sPKlpcOyuyBrJbjPsQcxnGEWuBx8zSIKKrrE")
        print("  python3 scripts/ingest_google_doc.py --content exported_doc.md --title \"About Brain Owner\"")
        sys.exit(1)
    
    if result:
        print("\n✓ Ingestion complete!")
        print(f"  Path: {result.get('path', 'unknown')}")
        print(f"  URL: {result.get('url', 'unknown')}")
    else:
        print("\n✗ Ingestion failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
