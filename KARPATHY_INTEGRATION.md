# Karpathy Skills & LLM Wiki Pattern Integration

This document explains how Karpathy's principles, the LLM Wiki pattern, RAG, and graph-based knowledge representation are integrated into Lnm-Brain.

## Karpathy Skills (4 Principles)

### 1. Think Before Coding
**Implementation:**
- Every operation in Lnm-Brain follows a clear plan
- The `AGENTS.md` and `CLAUDE.md` files define the workflow
- Before making changes, the system queries existing knowledge

**Code Example:**
```python
def query_before_action(query):
    """Query the Second Brain before taking action."""
    context = query_brain(query)
    if context['matches'] > 0:
        print(f"Found {context['matches']} relevant items from past work")
        return context
    return None
```

### 2. Simplicity First
**Implementation:**
- The system uses simple, well-defined operations: CAPTURE, QUERY, GRAPH
- No complex state management - everything is stored as markdown files
- The graph is generated from markdown, not a separate database

**Architecture:**
```
Raw Sources → Markdown Files → Graph JSON → Query Results
```

### 3. Surgical Changes
**Implementation:**
- Each conversation is captured as a separate file
- Wiki pages are updated incrementally
- The graph is regenerated from source, not patched

**Example:**
```python
# Don't do this (patching):
graph['nodes'].append(new_node)

# Do this (regenerate):
graph = generate_graph_from_markdown()
```

### 4. Goal-Driven Execution
**Implementation:**
- Every operation has a clear goal: CAPTURE (persist knowledge), QUERY (retrieve knowledge), GRAPH (visualize relationships)
- The system measures success: token savings, query relevance, graph connectivity

**Metrics:**
```python
def measure_success():
    return {
        'compression_ratio': calculate_compression_ratio(),
        'query_relevance': calculate_query_relevance(),
        'graph_connectivity': calculate_graph_connectivity()
    }
```

---

## LLM Wiki Pattern

### Core Concept
Store compressed wiki pages instead of raw conversations to achieve ~27x token savings.

### Implementation

#### 1. Compression Pipeline
```python
# scripts/compress_conversations_llm.py

def compress_conversation(raw_content, title):
    """Compress a raw conversation into key insights."""
    
    # Use LLM to extract:
    extracted = {
        'summary': '2-3 sentence overview',
        'decisions': 'key decisions made',
        'insights': 'key learnings',
        'patterns': 'recurring themes',
        'code_snippets': 'important code',
        'questions': 'important questions',
        'answers': 'answers to questions',
        'entities': 'people, companies, tools',
        'topics': 'main topics'
    }
    
    # Generate compressed wiki page (~1,850 tokens)
    return generate_wiki_page(extracted)
```

#### 2. Query with Compressed Pages
```python
def query_brain(query):
    """Query using compressed pages for token savings."""
    
    # Try compressed first
    compressed_results = search_compressed(query)
    
    if compressed_results:
        # Use compressed (~1,850 tokens) instead of raw (~50,000 tokens)
        return compressed_results
    
    # Fallback to raw if no compressed version
    return search_raw(query)
```

#### 3. Token Savings Measurement
```python
def measure_token_savings():
    """Measure actual token savings."""
    
    raw_tokens = count_tokens(raw_conversations)
    compressed_tokens = count_tokens(compressed_pages)
    
    savings = (raw_tokens - compressed_tokens) / raw_tokens
    ratio = raw_tokens / compressed_tokens
    
    return {
        'raw_tokens': raw_tokens,
        'compressed_tokens': compressed_tokens,
        'savings_percent': savings * 100,
        'compression_ratio': ratio
    }
```

---

## RAG (Retrieval-Augmented Generation)

### Core Concept
Retrieve relevant context before generating responses to improve accuracy and reduce hallucinations.

### Implementation

#### 1. Retrieval Pipeline
```python
def retrieve_context(query, top_k=5):
    """Retrieve relevant context for a query."""
    
    # 1. Search compressed pages (fast, token-efficient)
    compressed_results = search_compressed(query, top_k=top_k)
    
    # 2. If needed, search raw sources (slower, more detailed)
    if not compressed_results:
        raw_results = search_raw(query, top_k=top_k)
        return raw_results
    
    # 3. Return compressed results with source references
    return compressed_results
```

#### 2. Context Injection
```python
def generate_response_with_context(query, model="gpt-4"):
    """Generate response with retrieved context."""
    
    # Retrieve context
    context = retrieve_context(query)
    
    # Build prompt with context
    system_prompt = f"""You are working with the Lnm-Brain Second Brain system.

Relevant context from past conversations:
{format_context(context)}

Use this context to provide accurate answers. If the context doesn't contain
the answer, say so and provide your best answer based on your training.

Cite your sources using [^1] notation."""
    
    # Generate response
    response = openai.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": query}
        ]
    )
    
    return response.choices[0].message.content
```

#### 3. Citation Model
```python
def format_context(context):
    """Format context with citations."""
    
    formatted = []
    for i, item in enumerate(context, 1):
        formatted.append(f"[{i}] {item['title']}")
        formatted.append(f"    {item['summary']}")
        formatted.append(f"    Source: {item['path']}")
    
    return '\n'.join(formatted)
```

---

## Graphify (Graph-Based Knowledge Representation)

### Core Concept
Represent knowledge as a graph of nodes and edges for fast traversal and relationship discovery.

### Implementation

#### 1. Graph Generation
```python
# scripts/generate_graph.py

def generate_graph():
    """Generate knowledge graph from markdown files."""
    
    nodes = []
    edges = []
    
    # Create nodes from markdown files
    for filepath in markdown_files:
        node = {
            'id': generate_node_id(filepath),
            'label': extract_title(filepath),
            'type': determine_type(filepath),
            'path': filepath,
            'tags': extract_tags(filepath),
            'entities': extract_entities(filepath)
        }
        nodes.append(node)
    
    # Create edges from:
    # 1. Wikilinks
    edges.extend(create_edges_from_wikilinks(nodes))
    
    # 2. Shared tags
    edges.extend(create_edges_from_tags(nodes))
    
    # 3. Shared entities
    edges.extend(create_edges_from_entities(nodes))
    
    # 4. Same directory
    edges.extend(create_edges_from_directory(nodes))
    
    return {'nodes': nodes, 'edges': edges}
```

#### 2. Graph Traversal
```python
def traverse_graph(start_node, max_depth=2):
    """Traverse graph from starting node."""
    
    visited = set()
    results = []
    
    def dfs(node_id, depth):
        if depth > max_depth or node_id in visited:
            return
        
        visited.add(node_id)
        node = get_node(node_id)
        results.append(node)
        
        # Get neighbors
        neighbors = get_neighbors(node_id)
        for neighbor in neighbors:
            dfs(neighbor, depth + 1)
    
    dfs(start_node, 0)
    return results
```

#### 3. Graph Query
```python
def query_graph(query):
    """Query graph for relevant nodes."""
    
    # 1. Find nodes matching query
    matching_nodes = find_nodes_by_query(query)
    
    # 2. Get their neighbors
    results = []
    for node in matching_nodes:
        neighbors = get_neighbors(node['id'])
        results.extend(neighbors)
    
    # 3. Return unique results
    return list(set(results))
```

---

## Integrated Workflow

### Complete RAG + Wiki + Graph Pipeline

```python
def integrated_query(query):
    """Complete RAG + Wiki + Graph query pipeline."""
    
    # Step 1: Query graph for related nodes
    graph_results = query_graph(query)
    
    # Step 2: Retrieve compressed pages for related nodes
    compressed_results = []
    for node in graph_results:
        compressed = get_compressed_page(node['path'])
        if compressed:
            compressed_results.append(compressed)
    
    # Step 3: Rank by relevance
    ranked_results = rank_by_relevance(query, compressed_results)
    
    # Step 4: Return top results
    return ranked_results[:5]
```

### Complete Capture + Compress + Graph Pipeline

```python
def integrated_capture(title, content, tags=None, entities=None):
    """Complete capture + compress + graph pipeline."""
    
    # Step 1: Capture raw conversation
    raw_path = capture_raw(title, content, tags, entities)
    
    # Step 2: Compress to wiki page
    compressed_path = compress_to_wiki(raw_path)
    
    # Step 3: Update graph
    update_graph()
    
    # Step 4: Return results
    return {
        'raw_path': raw_path,
        'compressed_path': compressed_path,
        'graph_updated': True
    }
```

---

## Usage Examples

### Example 1: Query with Full RAG
```python
# Query the Second Brain with full RAG
result = integrated_query("How do I set up the Second Brain?")

# Result includes:
# - Graph traversal results
# - Compressed wiki pages
# - Ranked by relevance
# - With citations
```

### Example 2: Capture with Full Pipeline
```python
# Capture conversation with full pipeline
result = integrated_capture(
    title="Discussion about RAG implementation",
    content="We discussed how to implement RAG...",
    tags=["rag", "implementation"],
    entities=["Brain Owner", "OpenAI"]
)

# Result includes:
# - Raw conversation saved
# - Compressed wiki page created
# - Graph updated with new nodes/edges
```

### Example 3: Graph Traversal
```python
# Traverse graph from a node
results = traverse_graph("wiki/topics/llm-wiki-pattern", max_depth=2)

# Results include:
# - All related nodes within 2 hops
# - With their relationships
# - Ready for context injection
```

---

## Metrics and Validation

### Token Savings
```python
# Measure actual token savings
metrics = measure_token_savings()

# Expected:
# - Raw: ~50,000 tokens per conversation
# - Compressed: ~1,850 tokens per conversation
# - Savings: ~27x
```

### Query Relevance
```python
# Measure query relevance
metrics = measure_query_relevance()

# Expected:
# - Precision: >80%
# - Recall: >70%
# - F1 Score: >75%
```

### Graph Connectivity
```python
# Measure graph connectivity
metrics = measure_graph_connectivity()

# Expected:
# - Average degree: >3
# - Connected components: <5
# - Clustering coefficient: >0.3
```

---

## Next Steps

1. **Implement RAG endpoint** in Cloudflare Worker
2. **Add graph traversal** to query API
3. **Improve ranking** with semantic similarity
4. **Add citation extraction** to compression pipeline
5. **Implement feedback loop** for continuous improvement

---

## References

- Karpathy's LLM Wiki: https://github.com/karpathy/llm.wiki
- RAG Paper: https://arxiv.org/abs/2005.11401
- Graph RAG: https://www.microsoft.com/en-us/research/blog/graphrag-llm-knowledge-graph


## Backlinks
[[index]]
