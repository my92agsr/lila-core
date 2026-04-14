# Lila: Persistent Operator

Telegram-native memory infrastructure for long-running personal AI assistants.

Lila is a Telegram-native persistent operator for assistants that need continuity, not just replies. It combines structured memory, Voyage-powered semantic retrieval, `sqlite-vec` local vector search, FTS fallback, scheduled work, proactive delivery, and context compression so an assistant can carry useful state across time without collapsing into raw chat history.

## Core Idea

Most assistants are stateless request handlers with a conversational shell. Lila takes a different approach:

- memory is a first-class system, not a transcript archive
- context is distilled and reloaded across sessions
- scheduled and proactive workflows are built into the runtime
- the assistant can operate over time, not just per message

## Architecture

### Memory System

- **Two-sector memory:** episodic turns and distilled semantic facts
- **Embeddings:** Voyage AI powers index-time and query-time embeddings
- **Vector retrieval:** `sqlite-vec` handles local semantic search against stored memory chunks
- **Fallback retrieval:** SQLite FTS5 covers exact-match and keyword recovery
- **Reranking:** Voyage reranking improves relevance before memory enters prompt context
- **Salience scoring:** corrections, preferences, decisions, and explicit save signals are weighted higher
- **Decay:** low-signal episodic context fades naturally
- **Working memory:** a persistent markdown-backed state file for current priorities, people, projects, and open threads
- **Consolidation:** episodic memory is periodically distilled into reusable semantic memory
- **Entity graph:** structured profiles for people, projects, places, and organizations

### Live Retrieval Architecture

The memory retrieval stack is layered rather than monolithic:

- **Primary retrieval:** Voyage semantic embeddings drive memory recall over chunked history
- **Embedding strategy:** separate index-time and query-time models share a compatible vector space
- **Reranking:** a dedicated rerank pass narrows the top candidates before prompt injection
- **Fallback retrieval:** FTS5 remains available for exact-match and keyword recovery
- **Chunking:** per-speaker chunks capped around 300 tokens improve recall precision
- **Write path:** new turns are embedded at write time, with older history backfilled in migration passes
- **Scoring:** retrieval combines semantic similarity with salience weighting before reranking

### Runtime

- persistent Node.js service
- Telegram-native chat interface and media handling
- SQLite storage with FTS and vector support
- scheduled tasks with cron or one-off delays
- proactive outbound messaging and reminder execution
- optional heartbeat jobs for background monitoring and summaries
- session compression after long threads
- optional voice and media handling

### Model Routing

Messages can be routed by task complexity:

- lightweight models for greetings and trivial queries
- default models for normal conversation and tool use
- stronger models for coding, architecture, and multi-step reasoning

## Public-Safe Defaults

This public export removes personal deployment details and ships with generic defaults:

- no personal inbox addresses
- no user-specific heartbeat prompts
- no local machine paths
- no private dashboard or fleet configuration
- no private runtime data or git history

Telegram remains explicit because it is the real transport layer in this codebase, not an incidental implementation detail.

If you want to run Lila yourself, configure your own bot token, inbox integrations, and working-memory location through environment and local setup.

## Repository Layout

```text
src/
  agent.ts          agent runtime integration
  bot.ts            transport formatting and chat loop
  compression.ts    long-session summarization and reset
  consolidation.ts  episodic to semantic memory distillation
  db.ts             SQLite schema and queries
  heartbeat.ts      optional proactive task seeding
  memory.ts         retrieval, salience, working memory
  scheduler.ts      cron and delayed task execution
  tools.ts          MCP tools exposed to the assistant
  voice.ts          speech input/output helpers

scripts/
  setup.ts          interactive local setup
  status.ts         runtime status checks
```

## Stack

Current implementation:

- Node.js 20+
- TypeScript
- Claude Agent SDK
- Voyage AI for embeddings and reranking
- the public source currently pins `voyage-3-large`, `voyage-3`, and `rerank-2`
- Better-SQLite3
- SQLite FTS5
- sqlite-vec
- Grammy for Telegram transport
- OpenAI-compatible speech tooling
- optional third-party search and embedding providers

## Setup

```bash
npm install
cp .env.example .env
npm run build
npm run start
```

Typical configuration includes:

- chat transport credentials
- model API keys
- optional embedding provider key
- optional speech provider key

## Product Positioning

Lila is not just an assistant wrapper. It is a persistent operator with memory as a product surface.

That means the value is not only better answers. The value is operational continuity:

- what should still matter tomorrow
- what should be surfaced again later
- what belongs in durable memory versus ephemeral context
- what the assistant should proactively act on without being re-prompted

## License

Public reference implementation. Add the license you want before publishing.
