# Lila Core

Working-memory consolidation engine for **Lila** — the iOS app at
[lila.surf](https://lila.surf). Reads recent activity for a user from
Supabase, distills it into a structured `working_memory` record using
Claude, writes it back. The iOS client renders that record on its home
screen. Open source.

> **`lila.sh`** is this engine. **`lila.surf`** is the consumer iOS app
> built on top of it. This repo is the runtime; the App Store product is
> the surface.

## What this does

Once a day (or on demand), for each active user:

1. Reads recent rows from `public.{captures,tasks,reflections,messages,events}`.
2. Reads the previous `public.working_memory` row.
3. Renders a consolidation prompt and asks Claude to produce a structured
   summary — focus items, people threads, quiet items, an optional greeting
   context — each bullet carrying receipts back to the underlying records.
4. Validates the JSON against [`prompts/working-memory/schema.json`](./prompts/working-memory/schema.json).
5. Writes a new `working_memory` row.
6. The iOS app renders the latest row on next pull-to-refresh.

The voice rules (sparse is honest, no corporate language, time-bound
items first, every bullet has a receipt) live in
[`prompts/working-memory/system.md`](./prompts/working-memory/system.md).
The structure rules live in
[`prompts/working-memory/consolidate.md`](./prompts/working-memory/consolidate.md).

## Repository layout

```text
prompts/working-memory/
  system.md          Voice. Stable. Rarely changes.
  consolidate.md     Structure. Mustache-style placeholders. Iterate freely.
  schema.json        JSON Schema for the output. Source of truth.
  sample-input.json  Synthetic week of activity for prompt iteration.
  README.md          How to iterate the voice without touching Supabase.

src/working-memory/
  types.ts           ConsolidationInput / ConsolidationOutput.
  consolidation.ts   Render templates, call Claude, validate output.
  supabase.ts        Read source tables, write working_memory rows.

scripts/
  working-memory-consolidate.ts            Iterate against sample-input.json.
  working-memory-consolidate-supabase.ts   Run for one user against Supabase.
  working-memory-consolidate-all.ts        Run for every active user.

.github/workflows/
  consolidate.yml    Nightly cron + manual dispatch.
```

## Run it locally

```bash
# Iterate prompt voice (no DB):
ANTHROPIC_API_KEY=… npm run wm:consolidate

# Run for one user (real Supabase data):
ANTHROPIC_API_KEY=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
  npm run wm:consolidate:supabase -- --user you@example.com

# Run for everyone with recent activity:
ANTHROPIC_API_KEY=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
  npm run wm:consolidate:all
```

The **service-role key** bypasses Row Level Security so the script can
run on behalf of any user. Never ship it to a client. Never commit it.

## Automatic consolidation

The repo runs `wm:consolidate:all` nightly via GitHub Actions (see
[`.github/workflows/consolidate.yml`](./.github/workflows/consolidate.yml)).
It walks every user with activity in the last 7 days and writes them a
fresh `working_memory` row. Manual `workflow_dispatch` is wired so it can
be kicked off on demand.

Required repository secrets:

- `ANTHROPIC_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Stack

- Node.js 20+, TypeScript
- `@anthropic-ai/sdk` — Claude calls with prompt caching on the system prompt
- `@supabase/supabase-js` — read/write Supabase from server-side scripts

That's it. No agent runtime, no transports, no embeddings — those lived in
an earlier Telegram-bot iteration of this repo and have been removed. If
you need them back for another transport, the git history before the
"Drop Telegram bot, focus on consolidation engine" commit is the place to
look.

## Output contract

One JSON object per consolidation pass, written into
`public.working_memory`. Fields:

| Field              | Cardinality        | Notes                                     |
| ------------------ | ------------------ | ----------------------------------------- |
| `greeting_context` | optional, nullable | Short phrase. Often null.                 |
| `focus_items`      | 0–4                | The week's actually-load-bearing things.  |
| `people_threads`   | 0–2 people         | Each with 1–3 unresolved items.           |
| `quiet_items`      | 0–4                | Captured but stalled ≥10 days, not dead.  |

Every bullet carries `source_ids: [{table, id}, …]` — the receipts the
iOS tap-to-expand sheet resolves against the source rows.

## Sparse is honest

The single most important rule. If the user had a quiet week, the JSON
should reflect that — empty arrays, not invented bullets. A half-empty
home screen is more credible than four padded items.

## License

MIT. See [`LICENSE`](./LICENSE).
