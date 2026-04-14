# Lila: Persistent Operator

Persistent memory infrastructure for long-running personal AI assistants.

Lila is a chat-first operator built for assistants that need continuity, not just replies. It combines session persistence, structured memory, scheduled work, proactive delivery, and context compression so an assistant can carry useful state across time without collapsing into raw chat history.

## GitHub Description

Public repo description:
`Persistent memory infrastructure for long-running personal AI assistants.`

## Core Idea

Most assistants are stateless request handlers with a conversational shell. Lila takes a different approach:

- memory is a first-class system, not a transcript archive
- context is distilled and reloaded across sessions
- scheduled and proactive workflows are built into the runtime
- the assistant can operate over time, not just per message

## Architecture

### Memory System

- **Two-sector memory:** episodic turns and distilled semantic facts
- **Semantic retrieval:** vector search with full-text fallback
- **Salience scoring:** corrections, preferences, decisions, and explicit save signals are weighted higher
- **Decay:** low-signal episodic context fades naturally
- **Working memory:** a persistent markdown-backed state file for current priorities, people, projects, and open threads
- **Consolidation:** episodic memory is periodically distilled into reusable semantic memory
- **Entity graph:** structured profiles for people, projects, places, and organizations

### Runtime

- persistent Node.js service
- SQLite storage with FTS and vector support
- scheduled tasks with cron or one-off delays
- proactive outbound messaging
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

If you want to run Lila yourself, configure your own transport, inbox integrations, and working-memory location through environment and local setup.

## Repository Layout

```text
src/
  agent.ts          Claude Agent SDK integration
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

- Node.js 20+
- TypeScript
- Claude Agent SDK
- Better-SQLite3
- sqlite-vec
- Grammy
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

That means the value is not only better answers. The value is continuity:

- what should still matter tomorrow
- what should be surfaced again later
- what belongs in durable memory versus ephemeral context
- what the assistant should proactively act on without being re-prompted

## License

Public reference implementation. Add the license you want before publishing.
