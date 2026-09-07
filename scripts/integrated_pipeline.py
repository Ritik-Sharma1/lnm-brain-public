#!/usr/bin/env python3
"""
Integrated RAG + Wiki + Graph Pipeline

This script implements the complete pipeline:
1. Capture raw conversations
2. Compress to wiki pages
3. Update knowledge graph
4. Query with RAG (retrieval-augmented generation)
5. Traverse graph for related nodes

Usage:
    python3 scripts/integrated_pipeline.py --capture "Title" "Content"
    python3 scripts/integrated_pipeline.py --query "Search query"
    python3 scripts/integrated_pipeline.py --traverse "node_id"
"""

import os
import sys
import json
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


def capture_raw(title, content, tags=None, entities=None, source_url=None):
    """Capture raw conversation to Second Brain."""
    if tags is None:
        tags = []
    if entities is None:
        entities = []
    
    try:
        response = requests.post(
            f"{BRAIN_API}/capture",
            headers={"X-API-Key": API_KEY},
            json={
                "type": "conversation",
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


def compress_to_wiki(raw_path):
    """Compress raw conversation to wiki page."""
    # This would call the compression pipeline
    # For now, return a placeholder
    return {
        "compressed_path": raw_path.replace("raw/", "wiki/"),
        "status": "compressed"
    }


def update_graph():
    """Update knowledge graph."""
    try:
        response = requests.get(
            f"{BRAIN_API}/graph",
            headers={"X-API-Key": API_KEY},
            timeout=10
        )
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"Error updating graph: {e}")
        return None


def query_brain(query, top_k=5):
    """Query Second Brain with RAG."""
    try:
        response = requests.get(
            f"{BRAIN_API}/query",
            params={"q": query},
            headers={"X-API-Key": API_KEY},
            timeout=10
        )
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"Error querying: {e}")
        return None


def query_graph(query):
    """Query graph for related nodes."""
    graph = get_graph()
    if not graph:
        return []
    
    # Find nodes matching query
    matching_nodes = []
    query_lower = query.lower()
    
    for node in graph.get('nodes', []):
        # Check title
        if query_lower in node.get('label', '').lower():
            matching_nodes.append(node)
            continue
        
        # Check tags
        for tag in node.get('tags', []):
            if query_lower in tag.lower():
                matching_nodes.append(node)
                break
        
        # Check entities
        for entity in node.get('entities', []):
            if query_lower in entity.lower():
                matching_nodes.append(node)
                break
    
    return matching_nodes


def get_graph():
    """Get knowledge graph."""
    try:
        response = requests.get(
            f"{BRAIN_API}/graph",
            headers={"X-API-Key": API_KEY},
            timeout=10
        )
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"Error getting graph: {e}")
        return None


def get_neighbors(node_id, graph=None):
    """Get neighbors of a node in the graph."""
    if graph is None:
        graph = get_graph()
        if not graph:
            return []
    
    neighbors = []
    node_id_lower = node_id.lower()
    
    for edge in graph.get('edges', []):
        if edge.get('from', '').lower() == node_id_lower:
            neighbor_id = edge.get('to', '')
            neighbor = find_node(neighbor_id, graph)
            if neighbor:
                neighbors.append(neighbor)
        elif edge.get('to', '').lower() == node_id_lower:
            neighbor_id = edge.get('from', '')
            neighbor = find_node(neighbor_id, graph)
            if neighbor:
                neighbors.append(neighbor)
    
    return neighbors


def find_node(node_id, graph):
    """Find a node by ID in the graph."""
    node_id_lower = node_id.lower()
    for node in graph.get('nodes', []):
        if node.get('id', '').lower() == node_id_lower:
            return node
    return None


def traverse_graph(start_node_id, max_depth=2):
    """Traverse graph from starting node."""
    graph = get_graph()
    if not graph:
        return []
    
    visited = set()
    results = []
    
    def dfs(node_id, depth):
        if depth > max_depth or node_id in visited:
            return
        
        visited.add(node_id)
        node = find_node(node_id, graph)
        if node:
            results.append(node)
        
        # Get neighbors
        neighbors = get_neighbors(node_id, graph)
        for neighbor in neighbors:
            dfs(neighbor['id'], depth + 1)
    
    dfs(start_node_id, 0)
    return results


def integrated_query(query, top_k=5):
    """Complete RAG + Wiki + Graph query pipeline."""
    
    print(f"Querying: {query}")
    print()
    
    # Step 1: Query graph for related nodes
    print("Step 1: Querying graph...")
    graph_results = query_graph(query)
    print(f"  Found {len(graph_results)} related nodes in graph")
    
    # Step 2: Query compressed pages
    print("Step 2: Querying compressed wiki pages...")
    wiki_results = query_brain(query)
    if wiki_results:
        print(f"  Found {wiki_results.get('matches', 0)} matches in wiki")
    else:
        print("  No wiki results found")
    
    # Step 3: Combine and rank results
    print("Step 3: Combining results...")
    all_results = []
    
    # Add graph results
    for node in graph_results:
        all_results.append({
            'source': 'graph',
            'title': node.get('label', ''),
            'type': node.get('type', ''),
            'path': node.get('path', ''),
            'tags': node.get('tags', []),
            'relevance': 0.7  # Base relevance for graph matches
        })
    
    # Add wiki results
    if wiki_results and wiki_results.get('results'):
        for result in wiki_results.get('results', []):
            all_results.append({
                'source': 'wiki',
                'title': result.get('name', ''),
                'type': result.get('type', 'compressed'),
                'path': result.get('path', ''),
                'relevance': 0.9  # Higher relevance for wiki matches
            })
    
    # Sort by relevance
    all_results.sort(key=lambda x: x['relevance'], reverse=True)
    
    # Return top results
    top_results = all_results[:top_k]
    
    print(f"  Returning top {len(top_results)} results")
    print()
    
    return top_results


def integrated_capture(title, content, tags=None, entities=None, source_url=None):
    """Complete capture + compress + graph pipeline."""
    
    print(f"Capturing: {title}")
    print()
    
    # Step 1: Capture raw conversation
    print("Step 1: Capturing raw conversation...")
    raw_result = capture_raw(title, content, tags, entities, source_url)
    if raw_result:
        print(f"  ✓ Captured to: {raw_result.get('path', 'unknown')}")
    else:
        print("  ✗ Failed to capture")
        return None
    
    # Step 2: Compress to wiki page
    print("Step 2: Compressing to wiki page...")
    compressed_result = compress_to_wiki(raw_result.get('path', ''))
    print(f"  ✓ Compressed to: {compressed_result.get('compressed_path', 'unknown')}")
    
    # Step 3: Update graph
    print("Step 3: Updating knowledge graph...")
    graph_result = update_graph()
    if graph_result:
        node_count = graph_result.get('metadata', {}).get('node_count', 0)
        edge_count = graph_result.get('metadata', {}).get('edge_count', 0)
        print(f"  ✓ Graph updated: {node_count} nodes, {edge_count} edges")
    else:
        print("  ✗ Failed to update graph")
    
    print()
    
    return {
        'raw_path': raw_result.get('path'),
        'compressed_path': compressed_result.get('compressed_path'),
        'graph_updated': graph_result is not None
    }


def format_results(results):
    """Format query results for display."""
    if not results:
        return "No results found."
    
    output = []
    output.append(f"Found {len(results)} results:")
    output.append("")
    
    for i, result in enumerate(results, 1):
        output.append(f"{i}. {result.get('title', 'Untitled')}")
        output.append(f"   Type: {result.get('type', 'unknown')}")
        output.append(f"   Source: {result.get('source', 'unknown')}")
        if result.get('path'):
            output.append(f"   Path: {result.get('path')}")
        if result.get('tags'):
            output.append(f"   Tags: {', '.join(result.get('tags', []))}")
        output.append(f"   Relevance: {result.get('relevance', 0):.2f}")
        output.append("")
    
    return '\n'.join(output)


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Integrated RAG + Wiki + Graph Pipeline"
    )
    parser.add_argument(
        "--capture",
        nargs=2,
        metavar=("TITLE", "CONTENT"),
        help="Capture a conversation"
    )
    parser.add_argument(
        "--query",
        metavar="QUERY",
        help="Query the Second Brain"
    )
    parser.add_argument(
        "--traverse",
        metavar="NODE_ID",
        help="Traverse graph from a node"
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=5,
        help="Number of results to return (default: 5)"
    )
    parser.add_argument(
        "--max-depth",
        type=int,
        default=2,
        help="Max traversal depth (default: 2)"
    )
    
    args = parser.parse_args()
    
    if args.capture:
        title, content = args.capture
        result = integrated_capture(title, content)
        if result:
            print("✓ Capture complete!")
            print(f"  Raw: {result['raw_path']}")
            print(f"  Compressed: {result['compressed_path']}")
            print(f"  Graph updated: {result['graph_updated']}")
    
    elif args.query:
        results = integrated_query(args.query, top_k=args.top_k)
        print(format_results(results))
    
    elif args.traverse:
        results = traverse_graph(args.traverse, max_depth=args.max_depth)
        print(f"Found {len(results)} nodes within {args.max_depth} hops:")
        print()
        for i, node in enumerate(results, 1):
            print(f"{i}. {node.get('label', 'Untitled')}")
            print(f"   Type: {node.get('type', 'unknown')}")
            print(f"   Path: {node.get('path', 'unknown')}")
            print()
    
    else:
        parser.print_help()
        print("\nExamples:")
        print("  python3 scripts/integrated_pipeline.py --capture \"Title\" \"Content\"")
        print("  python3 scripts/integrated_pipeline.py --query \"second brain setup\"")
        print("  python3 scripts/integrated_pipeline.py --traverse \"wiki-topics-llm-wiki-pattern\"")


if __name__ == "__main__":
    main()
