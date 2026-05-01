# Lila Core

A persistent operator runtime. Memory, model routing, scheduling, proactive
execution. Open source.

> **`lila.sh`** is this runtime. **`lila.surf`** is Lila — the consumer iOS
> app built on top of it. This repo is the engine; the App Store product is
> the reference deployment.

Most assistants are stateless request handlers with a conversational shell.
Lila Core is designed to behave like a real assistant: it carries context
across days and weeks, distills what matters, routes work across models,
watches connected systems, and pushes updates when something materially
changes. The transport is configurable — today's reference loop is
Telegram; the iOS client at `lila.surf` is a richer surface on the same
core.

## What's in here

- **Two-sector memory.** Episodic turns plus distilled semantic facts.
  Voyage-powered embeddings, `sqlite-vec` for local vector search, FTS5
  fallback, salience-weighted retrieval, dedicated rerank pass.
- **Working memory.** A persistent model of the user's life — current
  priorities, active people, open threads — refreshed by a nightly
  consolidation pass. The structured form of this drives the iOS home
  screen; see [`prompts/working-memory/`](./prompts/working-memory).
- **Consolidation.** Episodic memory is periodically distilled into reusable
  semantic memory; entities (people, projects, places, organizations) are
  extracted into a structured graph.
- **Model routing.** Lightweight models for trivial replies, default models
  for normal turns, stronger models for coding and multi-step reasoning.
  Cost and latency tracked per turn.
- **Scheduling and proactivity.** Cron and one-off delays, heartbeat jobs
  for background monitoring, deduplicated proactive outbound messaging,
  inbox triage and outbound notification through MCP-style tools.
- **Compression.** Long sessions get summarized and reset without losing
  durable facts.

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────┐
│  Transport (Telegram today, iOS / others next)              │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│  Agent runtime  (Claude Agent SDK, model routing)           │
└────────────────────────────┬────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
┌───────▼────────┐  ┌────────▼────────┐  ┌────────▼────────┐
│  Memory        │  │  Tools          │  │  Scheduler      │
│  ─ episodic    │  │  ─ inbox        │  │  ─ cron         │
│  ─ semantic    │  │  ─ search       │  │  ─ heartbeat    │
│  ─ working     │  │  ─ outbound     │  │  ─ proactive    │
│  ─ entities    │  │                 │  │                 │
└───────┬────────┘  └─────────────────┘  └─────────────────┘
        │
┌───────▼────────────────────────────────────────────────────┐
│  Storage  (SQLite + FTS5 + sqlite-vec, Voyage embeddings)  │
└────────────────────────────────────────────────────────────┘
```

## Working memory and the iOS surface

The iOS client at `lila.surf` reads from a structured working-memory record
that this runtime produces. The contract — what the consolidation prompt
emits and what the client renders — lives in
[`prompts/working-memory/`](./prompts/working-memory):

- `system.md` — Lila's voice (stable).
- `consolidate.md` — the structure prompt with input placeholders.
- `schema.json` — JSON Schema for the output.
- `sample-input.json` — synthetic week of activity for prompt iteration.

Iterate the voice without setting up the rest of the system:

```bash
ANTHROPIC_API_KEY=... npm run wm:consolidate
```

The CLI renders the prompts against a sample input, runs them through
Claude with prompt caching on the system prompt, validates the JSON output
against `schema.json`, and prints both the raw output and a text rendering
of how the home screen would read.

The iOS client itself is closed-source (lives in a separate repo for App
Store reasons). What's open here is the runtime that produces the data
the client renders.

## Repository layout

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

prompts/
  working-memory/   system + structure prompts, schema, samples

scripts/
  setup.ts                       interactive local setup
  status.ts                      runtime status checks
  working-memory-consolidate.ts  prompt iteration CLI
```

## Stack

- Node.js 20+, TypeScript
- Claude Agent SDK
- Voyage AI for embeddings and reranking (`voyage-3-large`, `voyage-3`,
  `rerank-2`)
- Better-SQLite3 + FTS5 + sqlite-vec
- Grammy for Telegram transport
- OpenAI-compatible speech tooling (optional)

## Setup

```bash
npm install
cp .env.example .env
npm run build
npm run start
```

Typical configuration:

- chat transport credentials
- model API keys
- optional embedding provider key
- optional speech provider key

## Public-safe defaults

This is the public export. It does not contain personal deployment
details — no inbox addresses, no machine paths, no private dashboard
configuration, no private runtime data. To run Lila Core yourself,
configure your own bot token, inbox integrations, and working-memory
location through environment and local setup.

## Naming and history

This repo was previously distributed under the codename
`Lila--Persistent-Operator`. The runtime is now called **Lila Core**; the
codename is retired. The product built on top of Lila Core is **Lila**, an
iOS app at [`lila.surf`](https://lila.surf). The runtime itself lives at
[`lila.sh`](https://lila.sh).

## License

MIT. See [`LICENSE`](./LICENSE).
