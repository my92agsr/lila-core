# Working Memory Consolidation Prompts

These files drive the nightly consolidation job that produces the iOS home
screen's working memory. The home screen is the first user-visible AI-native
moment in the product, and its quality is mostly the quality of these prompts.

## What lives here

- `system.md` — Lila's voice. Stable. Excerpted from the branding voice doc.
  Rarely changes. Loaded as the system prompt.
- `consolidate.md` — the consolidation task itself. Variable inputs in
  Mustache-style `{{placeholder}}` form. Schema described inline. Loaded as the
  user message. Iterate this file freely; the schema lives next to it.
- `schema.json` — JSON Schema (draft 2020-12) for the consolidation output.
  Source of truth for what the iOS client will read from Supabase.
- `sample-input.json` — synthetic week of activity for one fake user. Used by
  the CLI below to iterate voice without needing real data.

## Iterate the voice

```bash
npm run wm:consolidate                              # uses sample-input.json
npm run wm:consolidate -- --input path/to/data.json # custom input
npm run wm:consolidate -- --model claude-opus-4-7   # override model
```

The script prints the rendered prompt, runs it through Claude, validates the
JSON output against `schema.json`, and pretty-prints the result. Read the
bullets out loud. If they sound like a SaaS dashboard, edit `system.md` or
`consolidate.md` and re-run. Repeat until the voice lands.

The brief says to plan a real afternoon for this before any UI work. Take it.

## Why two files

The brief calls for the system prompt and structure prompt to live separately
"so you can iterate on voice without breaking schema." That's the split:

- `system.md` answers _who is writing this_.
- `consolidate.md` answers _what they are writing right now_.

Touch `system.md` to change the personality. Touch `consolidate.md` to change
the inputs, the field shapes, or the constraints on what gets surfaced.

## Output contract

The consolidation produces one JSON object per user per night, written into
the `working_memory` row in Supabase. Fields:

| Field              | Cardinality       | Notes                                          |
| ------------------ | ----------------- | ---------------------------------------------- |
| `greeting_context` | optional, nullable| Short phrase. Often null. When present, lands. |
| `focus_items`      | 0–4               | The week's actually-load-bearing things.       |
| `people_threads`   | 0–2 people        | Each with 1–3 unresolved items.                |
| `quiet_items`      | 0–4               | Captured / committed but stalled, not dead.    |

Every bullet carries `source_ids`: `[{ "table": "...", "id": "..." }, ...]`
so the iOS tap-to-expand can resolve receipts. Bullets without source_ids are
treated as malformed by the client and dropped.

## Sparse is honest

The single most important rule. If the user had a quiet week, the JSON should
reflect that — empty arrays, not invented bullets. A half-empty home screen
is more credible than four padded items.

## Where this gets called from

Two scripts share the same consolidation logic in
`src/working-memory/consolidation.ts`:

- **`scripts/working-memory-consolidate.ts`** — runs against an input JSON
  file (default `sample-input.json`). For prompt iteration; does not touch
  Supabase.
- **`scripts/working-memory-consolidate-supabase.ts`** — runs end-to-end
  against a real user. Reads recent `captures` / `tasks` / `reflections` /
  `messages` / `events` rows + the previous `working_memory` row from
  Supabase, runs the prompt, and writes a new `working_memory` row that
  the iOS client picks up.

```bash
# Real consolidation against Supabase data:
ANTHROPIC_API_KEY=… \
SUPABASE_URL=https://YOUR_REF.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=… \
  npm run wm:consolidate:supabase -- --user you@example.com --first-name Matt
```

`--dry-run` runs the prompt and prints the result without writing the row.
`--show-input` prints what was loaded from Supabase before running. Use
both together to debug "why does it think X" without burning rows.

Future: a Railway endpoint `POST /memory/consolidate` triggered by nightly
cron and the on-demand refresh button on iOS. The endpoint will be a thin
wrapper around `runConsolidation()` and `writeWorkingMemory()` in
`src/working-memory/`; the script above is the same path, hand-cranked.
