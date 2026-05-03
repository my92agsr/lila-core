# Contributing

Lila Core is currently a single-author project. The protocol and
internals are documented — see [`ARCHITECTURE.md`](./ARCHITECTURE.md),
[`prompts/working-memory/`](./prompts/working-memory/), and the ADRs
in [`ADR/`](./ADR/) — so you can read it, fork it, run it, build a
client against it, or copy the parts you find useful.

Issues and discussions are open. PRs are welcome but I may not act on
them while 1.0 is shipping; the bar for merging is "this matches the
direction in [`MANIFESTO.md`](./MANIFESTO.md) and doesn't expand the
1.0 surface area." Bug fixes and docs improvements are the easiest
path to merge.

If you want to build something on top of `lila-core` — a different
client, a different surface, a different consolidation strategy — go
ahead. The license is MIT. The repo is the protocol.

## Things that will move quickly

- Bug fixes with a clear repro.
- Documentation: typos, broken links, clearer prose, additional ADRs
  for non-obvious choices you spotted that aren't yet captured.
- Prompt iteration that demonstrably improves output on the synthetic
  fixtures in [`prompts/working-memory/sample-input.json`](./prompts/working-memory/sample-input.json).

## Things that will move slowly or not at all

- New connectors (Google Calendar, Gmail, etc.). The 1.0 spec is
  Apple-Calendar-via-EventKit only. Connectors return as a deliberate
  1.1+ scope, not opportunistically.
- Vector retrieval / pgvector wiring. See
  [ADR-001](./ADR/ADR-001-no-pgvector-in-1.0.md) for why this is out
  of 1.0.
- Multiple-conversation UX. See
  [ADR-002](./ADR/ADR-002-one-continuous-conversation.md).
- Anything that makes the surface area bigger without making the core
  claim sharper.

## Style

- Match the voice of the existing prose. Observant, specific, slightly
  dry. No marketing voice. No emoji in commits, code, or docs unless
  the file already uses them.
- Do not introduce new dependencies without a strong reason. The
  package surface is small on purpose.
- Run `npm run typecheck` before opening a PR.

If something here is wrong or out of date, the right move is a PR that
fixes the doc.
