#!/usr/bin/env python3
"""
Sub-Agent Processing System

Launches multiple "sub-agents" to process conversations, extract entities,
create wikilinks, and generate entity pages. Implements the "10 sub-agents"
workflow from the Build Your AI Brain Guide.

Usage:
    python3 scripts/process_conversations.py raw/conversations/
"""

import os
import sys
import json
import re
from pathlib import Path
from collections import defaultdict
from datetime import datetime

class EntityExtractor:
    """Extracts entities (people, companies, tools) from conversations."""

    def __init__(self):
        self.patterns = {
            'people': [
                r'\b[A-Z][a-z]+ [A-Z][a-z]+\b',  # First Last
                r'\b[A-Z][a-z]+ [A-Z]\. [A-Z][a-z]+\b',  # First M. Last
            ],
            'companies': [
                r'\b(?:Google|OpenAI|Anthropic|Microsoft|Apple|Amazon|Meta|GitHub|Cloudflare|Vercel|Netlify)\b',
            ],
            'tools': [
                r'\b(?:Python|JavaScript|TypeScript|React|Vue|Angular|Node\.js|Django|Flask|FastAPI|PostgreSQL|MongoDB|Redis|Docker|Kubernetes|AWS|GCP|Azure)\b',
            ],
            'projects': [
                r'\b(?:ExampleProject|Lnm-Brain|Second Brain|AI Brain)\b',
            ]
        }

    def extract(self, text):
        """Extract all entities from text."""
        entities = defaultdict(list)

        for category, patterns in self.patterns.items():
            for pattern in patterns:
                matches = re.findall(pattern, text, re.IGNORECASE)
                entities[category].extend(matches)

        # Deduplicate
        for category in entities:
            entities[category] = list(set(entities[category]))

        return entities


class TopicExtractor:
    """Extracts topics and themes from conversations."""

    def __init__(self):
        self.topic_keywords = {
            'coding': ['code', 'programming', 'function', 'class', 'variable', 'debug', 'error', 'fix'],
            'web': ['web', 'website', 'html', 'css', 'frontend', 'backend', 'api', 'http'],
            'ai': ['ai', 'artificial intelligence', 'machine learning', 'llm', 'gpt', 'claude', 'prompt'],
            'data': ['data', 'database', 'sql', 'query', 'json', 'csv', 'pandas'],
            'devops': ['deploy', 'docker', 'kubernetes', 'ci/cd', 'pipeline', 'server'],
            'mobile': ['mobile', 'ios', 'android', 'app', 'react native', 'flutter'],
            'business': ['business', 'startup', 'revenue', 'customer', 'marketing', 'sales'],
        }

    def extract(self, text):
        """Extract topics from text."""
        text_lower = text.lower()
        topics = []

        for topic, keywords in self.topic_keywords.items():
            if any(keyword in text_lower for keyword in keywords):
                topics.append(topic)

        return topics


class WikilinkGenerator:
    """Generates wikilinks between related conversations."""

    def __init__(self, conversations):
        self.conversations = conversations
        self.entity_index = defaultdict(list)
        self.topic_index = defaultdict(list)

        # Build indexes
        for conv in conversations:
            filepath = conv['filepath']
            title = conv['title']

            for entity in conv.get('entities', []):
                self.entity_index[entity.lower()].append(filepath)

            for topic in conv.get('topics', []):
                self.topic_index[topic].append(filepath)

    def generate_links(self, conversation):
        """Generate wikilinks for a conversation."""
        links = []

        # Link by entities
        for entity in conversation.get('entities', []):
            related = self.entity_index.get(entity.lower(), [])
            for filepath in related:
                if filepath != conversation['filepath']:
                    links.append(filepath)

        # Link by topics
        for topic in conversation.get('topics', []):
            related = self.topic_index.get(topic, [])
            for filepath in related:
                if filepath != conversation['filepath']:
                    links.append(filepath)

        # Deduplicate and limit
        links = list(set(links))[:5]  # Max 5 links

        return links


class EntityPageGenerator:
    """Generates entity pages that link all related conversations."""

    def __init__(self, conversations):
        self.conversations = conversations
        self.entity_conversations = defaultdict(list)

        # Group conversations by entity
        for conv in conversations:
            for entity in conv.get('entities', []):
                self.entity_conversations[entity].append(conv)

    def generate_page(self, entity):
        """Generate an entity page."""
        related_convs = self.entity_conversations[entity]

        if not related_convs:
            return None

        # Sort by date
        related_convs.sort(key=lambda x: x.get('date', ''), reverse=True)

        # Build markdown
        markdown = f"""# {entity}

**Type**: Entity
**Related Conversations**: {len(related_convs)}

## Overview

This page collects all conversations mentioning **{entity}**.

## Related Conversations

"""

        for conv in related_convs:
            safe_title = conv['title'].replace(' ', '-').lower()
            markdown += f"- [[{safe_title}]] - {conv.get('date', 'unknown')}\n"

        return markdown


def process_conversations(conversations_dir):
    """Process all conversations with sub-agents."""
    print("🚀 Starting sub-agent processing system...")

    # Load all conversations
    conversations = []
    for filepath in Path(conversations_dir).glob("*.md"):
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()

        # Extract title from first line
        title = content.split('\n')[0].replace('#', '').strip()

        conversations.append({
            'filepath': str(filepath),
            'title': title,
            'content': content,
            'entities': [],
            'topics': []
        })

    print(f"📖 Loaded {len(conversations)} conversations")

    # Sub-Agent 1: Entity Extraction
    print("\n🤖 Sub-Agent 1: Extracting entities...")
    entity_extractor = EntityExtractor()
    for conv in conversations:
        entities = entity_extractor.extract(conv['content'])
        conv['entities'] = entities

    # Sub-Agent 2: Topic Extraction
    print("🤖 Sub-Agent 2: Extracting topics...")
    topic_extractor = TopicExtractor()
    for conv in conversations:
        topics = topic_extractor.extract(conv['content'])
        conv['topics'] = topics

    # Sub-Agent 3: Wikilink Generation
    print("🤖 Sub-Agent 3: Generating wikilinks...")
    link_generator = WikilinkGenerator(conversations)
    for conv in conversations:
        links = link_generator.generate_links(conv)
        conv['links'] = links

    # Sub-Agent 4: Entity Page Generation
    print("🤖 Sub-Agent 4: Generating entity pages...")
    entity_page_generator = EntityPageGenerator(conversations)

    # Create entity pages
    entity_dir = Path("wiki/entities")
    entity_dir.mkdir(parents=True, exist_ok=True)

    for entity in entity_page_generator.entity_conversations.keys():
        page_content = entity_page_generator.generate_page(entity)
        if page_content:
            safe_entity = entity.replace(' ', '-').lower()
            filepath = entity_dir / f"{safe_entity}.md"
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(page_content)
            print(f"  ✓ Created entity page: {safe_entity}.md")

    # Sub-Agent 5: Update conversations with wikilinks
    print("🤖 Sub-Agent 5: Updating conversations with wikilinks...")
    for conv in conversations:
        if conv['links']:
            # Add "See Also" section
            see_also = "\n## See Also\n\n"
            for link in conv['links']:
                link_title = Path(link).stem.replace('-', ' ').title()
                see_also += f"- [[{link_title}]]\n"

            # Append to content
            with open(conv['filepath'], 'a', encoding='utf-8') as f:
                f.write(see_also)

    # Sub-Agent 6: Generate topic pages
    print("🤖 Sub-Agent 6: Generating topic pages...")
    topic_dir = Path("wiki/topics")
    topic_dir.mkdir(parents=True, exist_ok=True)

    topic_conversations = defaultdict(list)
    for conv in conversations:
        for topic in conv['topics']:
            topic_conversations[topic].append(conv)

    for topic, convs in topic_conversations.items():
        markdown = f"""# {topic.title()}

**Type**: Topic
**Related Conversations**: {len(convs)}

## Overview

This page collects all conversations about **{topic}**.

## Related Conversations

"""
        for conv in convs:
            safe_title = conv['title'].replace(' ', '-').lower()
            markdown += f"- [[{safe_title}]]\n"

        filepath = topic_dir / f"{topic}.md"
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(markdown)
        print(f"  ✓ Created topic page: {topic}.md")

    # Sub-Agent 7: Update index
    print("🤖 Sub-Agent 7: Updating index...")
    update_index(conversations, entity_dir, topic_dir)

    # Sub-Agent 8: Update graph
    print("🤖 Sub-Agent 8: Updating graph...")
    update_graph(conversations, entity_dir, topic_dir)

    # Sub-Agent 9: Generate statistics
    print("🤖 Sub-Agent 9: Generating statistics...")
    generate_statistics(conversations, entity_dir, topic_dir)

    # Sub-Agent 10: Create summary report
    print("🤖 Sub-Agent 10: Creating summary report...")
    create_summary_report(conversations, entity_dir, topic_dir)

    print("\n✅ All sub-agents completed!")
    print(f"\n📊 Results:")
    print(f"  - Conversations processed: {len(conversations)}")
    print(f"  - Entity pages created: {len(list(entity_dir.glob('*.md')))}")
    print(f"  - Topic pages created: {len(list(topic_dir.glob('*.md')))}")


def update_index(conversations, entity_dir, topic_dir):
    """Update the main index.md with all pages."""
    index_path = Path("index.md")

    markdown = """# Lnm-Brain Index

This index catalogs all content in the knowledge graph.

## Conversations

"""

    for conv in conversations:
        safe_title = conv['title'].replace(' ', '-').lower()
        markdown += f"- [[{safe_title}]] - {conv.get('date', 'unknown')}\n"

    markdown += "\n## Entities\n\n"

    for filepath in entity_dir.glob("*.md"):
        entity_name = filepath.stem.replace('-', ' ').title()
        markdown += f"- [[{entity_name}]]\n"

    markdown += "\n## Topics\n\n"

    for filepath in topic_dir.glob("*.md"):
        topic_name = filepath.stem.title()
        markdown += f"- [[{topic_name}]]\n"

    with open(index_path, 'w', encoding='utf-8') as f:
        f.write(markdown)


def update_graph(conversations, entity_dir, topic_dir):
    """Update the graph.json with all nodes and edges."""
    graph_path = Path("graph/graph.json")

    nodes = []
    edges = []

    # Add conversation nodes
    for conv in conversations:
        safe_title = conv['title'].replace(' ', '-').lower()
        nodes.append({
            "id": safe_title,
            "label": conv['title'],
            "type": "conversation",
            "date": conv.get('date', 'unknown')
        })

    # Add entity nodes
    for filepath in entity_dir.glob("*.md"):
        entity_name = filepath.stem.replace('-', ' ').lower()
        nodes.append({
            "id": entity_name,
            "label": filepath.stem.replace('-', ' ').title(),
            "type": "entity"
        })

    # Add topic nodes
    for filepath in topic_dir.glob("*.md"):
        topic_name = filepath.stem
        nodes.append({
            "id": topic_name,
            "label": topic_name.title(),
            "type": "topic"
        })

    # Add edges (from wikilinks)
    for conv in conversations:
        safe_title = conv['title'].replace(' ', '-').lower()
        for link in conv.get('links', []):
            link_title = Path(link).stem
            edges.append({
                "from": safe_title,
                "to": link_title,
                "type": "related"
            })

    graph = {
        "nodes": nodes,
        "edges": edges
    }

    with open(graph_path, 'w', encoding='utf-8') as f:
        json.dump(graph, f, indent=2)


def generate_statistics(conversations, entity_dir, topic_dir):
    """Generate statistics about the knowledge graph."""
    stats = {
        "total_conversations": len(conversations),
        "total_entities": len(list(entity_dir.glob("*.md"))),
        "total_topics": len(list(topic_dir.glob("*.md"))),
        "generated_at": datetime.now().isoformat()
    }

    stats_path = Path("graph/stats.json")
    with open(stats_path, 'w', encoding='utf-8') as f:
        json.dump(stats, f, indent=2)


def create_summary_report(conversations, entity_dir, topic_dir):
    """Create a summary report of the processing."""
    report_path = Path("processing-report.md")

    markdown = f"""# Processing Report

**Generated**: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}

## Summary

- **Conversations Processed**: {len(conversations)}
- **Entity Pages Created**: {len(list(entity_dir.glob("*.md")))}
- **Topic Pages Created**: {len(list(topic_dir.glob("*.md")))}

## Top Entities

"""

    # Count entity mentions
    entity_counts = defaultdict(int)
    for conv in conversations:
        for entity in conv.get('entities', []):
            for category, entities in entity.items():
                entity_counts[entity] += 1

    # Sort and display top 10
    top_entities = sorted(entity_counts.items(), key=lambda x: x[1], reverse=True)[:10]
    for entity, count in top_entities:
        markdown += f"- {entity}: {count} mentions\n"

    markdown += "\n## Top Topics\n\n"

    # Count topic mentions
    topic_counts = defaultdict(int)
    for conv in conversations:
        for topic in conv.get('topics', []):
            topic_counts[topic] += 1

    # Sort and display
    for topic, count in sorted(topic_counts.items(), key=lambda x: x[1], reverse=True):
        markdown += f"- {topic}: {count} conversations\n"

    with open(report_path, 'w', encoding='utf-8') as f:
        f.write(markdown)


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/process_conversations.py <conversations_directory>")
        sys.exit(1)

    conversations_dir = sys.argv[1]

    if not os.path.exists(conversations_dir):
        print(f"Error: Directory not found: {conversations_dir}")
        sys.exit(1)

    process_conversations(conversations_dir)


if __name__ == "__main__":
    main()
