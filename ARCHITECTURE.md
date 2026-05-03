# Architecture

This is the deeper-dive on how Lila Core works. The README is the
two-minute pitch. This is the doc you read when you're deciding
whether to fork it.

## The two-primitive split

Lila Core is the runtime that builds the two missing primitives the
[manifesto](./MANIFESTO.md) names — memory and attention. Everything
in the codebase is either part of one or part of the other.

```
                ┌─────────────────────┐
   surfaces ───►│   capture endpoints │  Haiku classify  →  Sonnet shape
   (iOS, web)   └──────────┬──────────┘
                           ▼
                ┌─────────────────────┐
                │     postgres        │  captures, tasks, notes,
                │                     │  reflections, memories,
                │   (memory layer)    │  events, messages, …
                └──────────┬──────────┘
                           │  recent window (RLS-scoped)
                           ▼
                ┌─────────────────────┐
                │  consolidator       │  Sonnet, schema-validated
                │  (cron + on-demand) │
                └──────────┬──────────┘
                           │  one-row-per-user JSON
                           ▼
                ┌─────────────────────┐
   surfaces ◄───│  working_memory     │  focus_items, people_threads,
   (home)       │                     │  quiet_items, source_ids
                └──────────┬──────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │  proactive scan     │  ranks candidates, queues APNs
                │  (chained)          │
                └─────────────────────┘
```

## Memory primitive

The memory layer is everything underneath the consolidator output. It
has three jobs.

### 1. Capture and classification

Every user input lands at `POST /capture/classify` first
([`supabase/functions/capture-classify`](./supabase/functions/capture-classify/)).
This call uses Haiku — cheap and fast — to decide what kind of thing
the user just said: a task, a note, a reflection, a long-term memory,
a bookmark. Classification is forwarded to `POST /capture/shape`
([`supabase/functions/capture-shape`](./supabase/functions/capture-shape/)),
which uses Sonnet and the appropriate per-type prompt
([`_shared/prompts/shape_*.ts`](./supabase/functions/_shared/prompts/))
to extract structured fields.

The shaping step also calls `POST /capture/extract-tasks` when a long
note has embedded actions, and `POST /capture/distill-memory` when
something looks like a long-term fact about the user (a relationship,
a preference, a recurring concern).

### 2. Persistence and source receipts

Everything writes through
[`_shared/scopedSupabase.ts`](./supabase/functions/_shared/scopedSupabase.ts) —
a thin wrapper that auto-scopes every read and write by `user_id`,
backed by Postgres row-level security. The runtime never sees data
across users. Compromising the service key still leaves you fighting
RLS.

Every consolidated bullet that surfaces on the home screen carries a
`source_ids` array of `{table, id}` pairs. The iOS tap-to-expand sheet
resolves those receipts back to the original capture rows. A user can
always trace a surfaced bullet back to the words they actually wrote.
This is non-negotiable. The consolidator is required by the JSON
schema to emit at least one source per bullet
([`prompts/working-memory/schema.json`](./prompts/working-memory/schema.json)).

### 3. Consolidation

`POST /memory/consolidate`
([`supabase/functions/memory-consolidate`](./supabase/functions/memory-consolidate/))
runs nightly per user (and on-demand via `POST /memory/refresh`). It
reads a bounded recent window from `captures`, `tasks`, `events`,
`messages`, `notes`, and `reflections`; folds in any long-term
distilled memories; passes the assembled context to Sonnet using the
prompt at
[`_shared/prompts/consolidation.ts`](./supabase/functions/_shared/prompts/consolidation.ts);
parses and schema-validates the response; writes a single row to the
`working_memory` table.

There is **one row per user** in `working_memory`. The home screen is
never reading a feed of past consolidations. It reads the current one.
History lives in the underlying capture rows.

## Attention primitive

The attention layer uses the working-memory output to do work the user
didn't ask for.

### 1. The home screen

The iOS app fetches the user's current `working_memory` row and
renders it as a generated paragraph. There is no list view, no kanban,
no inbox. The home screen is what the system noticed this week. See
[`WORKING_MEMORY_EXAMPLE.md`](./WORKING_MEMORY_EXAMPLE.md) for what
this actually looks like at the data layer.

### 2. Conversation, anchored

`POST /conversation/send`
([`supabase/functions/conversation-send`](./supabase/functions/conversation-send/))
streams a single continuous conversation thread per user. Memory
carries across days. There are no chat sessions to start or end.

Tapping a bullet on the home screen calls `POST /conversation/anchor`
([`supabase/functions/conversation-anchor`](./supabase/functions/conversation-anchor/))
and seeds the conversation with the bullet's source rows. The user
opens with full context already loaded into the model.

The system prompt for the conversation is at
[`_shared/prompts/conversation.ts`](./supabase/functions/_shared/prompts/conversation.ts).
The voice rules at
[`_shared/voice.ts`](./supabase/functions/_shared/voice.ts) are imported
into every Sonnet prompt — voice is one source of truth.

### 3. Proactive layer

After every consolidation, `POST /memory/proactive-scan`
([`supabase/functions/memory-proactive-scan`](./supabase/functions/memory-proactive-scan/))
runs and decides whether anything in the new working memory deserves
to interrupt the user. Output is a queue of push candidates in the
`proactive_events` table.

Three cron jobs read that queue:

- [`proactive-deliver`](./supabase/functions/proactive-deliver/) — every
  5 minutes; drains anything ready to send.
- [`proactive-morning-brief`](./supabase/functions/proactive-morning-brief/)
  — hourly; generates the optional morning brief push.
- [`proactive-calendar-imminent`](./supabase/functions/proactive-calendar-imminent/)
  — every 15 minutes; surfaces calendar events 15-30 minutes ahead with
  context the user should walk in with.

Delivery is APNs HTTP/2
([`_shared/apns.ts`](./supabase/functions/_shared/apns.ts)). The bar
for a push is high. The default is silence.

## Model routing

Three Claude tiers, each picked deliberately:

- **Haiku** — capture classification. Fast, cheap, runs on every
  capture.
- **Sonnet** — shaping, consolidation, conversation, proactive scan.
  The reasoning happens here. Prompt caching is on the system prompt
  for every Sonnet call (see
  [`_shared/client.ts`](./supabase/functions/_shared/client.ts)).
- **Opus** — not used in 1.0. The consolidator is fast enough on
  Sonnet that the cost trade-off doesn't pay.

All model calls go through the single client in
[`_shared/client.ts`](./supabase/functions/_shared/client.ts) so model
identifiers and cache settings live in one place.

## RLS, secrets, and trust boundaries

- Edge Functions run with the service role key. They use
  `scopedSupabase` to drop privileges to the user's row scope before
  reading or writing.
- The iOS client authenticates with a Supabase user JWT; it cannot
  reach service-role endpoints directly.
- APNs credentials, the Anthropic key, and the service role key live
  in Edge Function secrets. Nothing in this repo's `.env.example`
  contains live values.

## What's not in 1.0

The 1.0 spec is explicit on a few things, and those are documented as
ADRs in [`ADR/`](./ADR/):

- No pgvector retrieval ([ADR-001](./ADR/ADR-001-no-pgvector-in-1.0.md))
- One continuous conversation per user, not session-based chat
  ([ADR-002](./ADR/ADR-002-one-continuous-conversation.md))
- No Railway, no long-running Node processes — Edge Functions are the
  runtime
- Apple Calendar via EventKit only — Google Calendar and Gmail are
  deferred to 1.1+

When in doubt, the spec prefers fewer moving parts shipping cleanly
over more moving parts shipping noisy.
