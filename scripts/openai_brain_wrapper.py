#!/usr/bin/env python3
"""
OpenAI Code wrapper with Lnm-Brain integration.

This script wraps OpenAI API calls with Second Brain context injection
and automatic capture of conversations.

Usage:
    python3 scripts/openai_brain_wrapper.py "Your question here"
    python3 scripts/openai_brain_wrapper.py --interactive
"""

import os
import sys
import json
import argparse
from datetime import datetime

try:
    import openai
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False
    print("Error: openai library not installed. Run: pip install openai")
    sys.exit(1)

try:
    import requests
    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False
    print("Error: requests library not installed. Run: pip install requests")
    sys.exit(1)

# Configuration
BRAIN_API = "https://your-worker-subdomain.workers.dev"
API_KEY = "YOUR_API_KEY"
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")

if not OPENAI_API_KEY:
    print("Error: OPENAI_API_KEY environment variable not set")
    print("Set it with: export OPENAI_API_KEY=your_key_here")
    sys.exit(1)


def query_brain(query):
    """Query the Second Brain for context."""
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
        print(f"Warning: Failed to query Second Brain: {e}")
        return {"query": query, "matches": 0, "results": [], "note": "Query failed"}


def capture_to_brain(title, content, tags=None, entities=None):
    """Capture conversation to Second Brain."""
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
                "entities": entities
            },
            timeout=10
        )
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"Warning: Failed to capture to Second Brain: {e}")
        return None


def extract_entities(text):
    """Extract entities from text."""
    import re
    entities = []
    
    # Names
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
    
    return list(set(entities))[:10]


def chat_with_brain(user_message, model="gpt-4o-mini", capture=True):
    """Chat with OpenAI, using Second Brain for context."""
    
    # Query Second Brain for relevant context
    print("Querying Second Brain for context...")
    brain_context = query_brain(user_message)
    
    # Build system prompt with brain context
    if brain_context.get("matches", 0) > 0:
        context_str = json.dumps(brain_context.get("results", []), indent=2)
        system_prompt = f"""You are working with the Lnm-Brain Second Brain system.

Relevant context from Second Brain (found {brain_context['matches']} matches):
{context_str}

Use this context to provide better answers. Reference specific information from the context when relevant.

At the end of your response, if you provided valuable information, suggest capturing it to the Second Brain."""
    else:
        system_prompt = """You are working with the Lnm-Brain Second Brain system.

No relevant context found in Second Brain. Provide your best answer based on your training.

At the end of your response, if you provided valuable information, suggest capturing it to the Second Brain."""
    
    # Call OpenAI
    print(f"Calling OpenAI ({model})...")
    client = openai.OpenAI(api_key=OPENAI_API_KEY)
    
    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message}
            ],
            temperature=0.7
        )
        
        assistant_message = response.choices[0].message.content
        return assistant_message, brain_context
        
    except Exception as e:
        print(f"Error calling OpenAI: {e}")
        return None, brain_context


def interactive_mode():
    """Run in interactive mode."""
    print("=" * 60)
    print("OpenAI + Lnm-Brain Interactive Mode")
    print("=" * 60)
    print("Type 'quit' or 'exit' to end the session")
    print()
    
    conversation_history = []
    
    while True:
        try:
            user_input = input("You: ").strip()
            
            if user_input.lower() in ['quit', 'exit', 'q']:
                print("\nEnding session...")
                break
            
            if not user_input:
                continue
            
            # Chat with brain
            assistant_message, brain_context = chat_with_brain(user_input)
            
            if assistant_message:
                print(f"\nAssistant: {assistant_message}\n")
                
                # Add to conversation history
                conversation_history.append({"role": "user", "content": user_input})
                conversation_history.append({"role": "assistant", "content": assistant_message})
            
        except KeyboardInterrupt:
            print("\n\nInterrupted. Ending session...")
            break
        except EOFError:
            print("\n\nEnd of input. Ending session...")
            break
    
    # Ask if user wants to capture the conversation
    if conversation_history and len(conversation_history) > 2:
        capture_choice = input("\nCapture this conversation to Second Brain? (y/n): ").strip().lower()
        if capture_choice in ['y', 'yes']:
            # Build conversation text
            conversation_text = "\n".join([
                f"{msg['role'].title()}: {msg['content']}" 
                for msg in conversation_history
            ])
            
            # Generate title
            title = input("Enter a title for this conversation: ").strip()
            if not title:
                title = f"Conversation {datetime.now().strftime('%Y-%m-%d %H:%M')}"
            
            # Extract entities
            all_text = " ".join([msg['content'] for msg in conversation_history])
            entities = extract_entities(all_text)
            
            # Capture
            print("Capturing to Second Brain...")
            result = capture_to_brain(title, conversation_text, entities=entities)
            
            if result:
                print(f"✓ Captured: {result.get('path', 'unknown')}")
            else:
                print("✗ Failed to capture")


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="OpenAI wrapper with Lnm-Brain integration"
    )
    parser.add_argument(
        "message",
        nargs="*",
        help="Message to send to OpenAI (use --interactive for chat mode)"
    )
    parser.add_argument(
        "-i", "--interactive",
        action="store_true",
        help="Run in interactive mode"
    )
    parser.add_argument(
        "-m", "--model",
        default="gpt-4o-mini",
        help="OpenAI model to use (default: gpt-4o-mini)"
    )
    parser.add_argument(
        "--no-capture",
        action="store_true",
        help="Don't capture to Second Brain"
    )
    
    args = parser.parse_args()
    
    if args.interactive:
        interactive_mode()
    elif args.message:
        # Single message mode
        user_message = " ".join(args.message)
        assistant_message, brain_context = chat_with_brain(
            user_message,
            model=args.model,
            capture=not args.no_capture
        )
        
        if assistant_message:
            print(assistant_message)
            
            # Ask if user wants to capture
            if not args.no_capture:
                capture_choice = input("\nCapture this to Second Brain? (y/n): ").strip().lower()
                if capture_choice in ['y', 'yes']:
                    title = input("Title: ").strip() or f"Quick query {datetime.now().strftime('%Y-%m-%d %H:%M')}"
                    entities = extract_entities(user_message + " " + assistant_message)
                    
                    conversation_text = f"User: {user_message}\n\nAssistant: {assistant_message}"
                    result = capture_to_brain(title, conversation_text, entities=entities)
                    
                    if result:
                        print(f"✓ Captured: {result.get('path', 'unknown')}")
    else:
        # No message provided, show help
        parser.print_help()
        print("\nExamples:")
        print("  python3 scripts/openai_brain_wrapper.py \"How do I set up the Second Brain?\"")
        print("  python3 scripts/openai_brain_wrapper.py --interactive")
        print("  python3 scripts/openai_brain_wrapper.py -m gpt-4 \"Explain RAG\"")


if __name__ == "__main__":
    main()
