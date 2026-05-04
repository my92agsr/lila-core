# Roadmap

`lila-core` evolves alongside the iOS app. Anything below 1.1 is locked.
Anything below 1.2 is intent, not commitment.

## 1.0 — what's here

- Two primitives running end-to-end: memory persistence (consolidation,
  source receipts, working memory) and attention (proactive scan, morning
  brief, calendar imminent).
- 13 Edge Functions covering capture, memory, conversation, connectors,
  push.
- Apple Calendar via EventKit. No other connectors.
- One conversation per user, ever (DB-enforced).
- Forward-compatible vector(1024) columns; no semantic retrieval at
  runtime.

## 1.1 — next

- **Drift category notifications.** Schema is already present; delivery
  is gated until the crisis-content sub-brief lands. Drift surfaces
  emotional patterns ("you've been quiet about Susanna for 9 days"), so
  the prompt design has higher stakes than any other category.
- **Tool use in conversation.** Lila acts inside the thread — marks a
  task resolved, schedules a reflection, snoozes a quiet item — instead
  of just describing what to do. Anthropic SDK already supports this;
  the wrapping is what's missing.
- **Google Calendar OAuth.** First non-Apple connector. Reuses the
  `events` table and the existing reconciliation pattern. The OAuth
  exchange lives in a new `connectors-google-calendar-*` function tree.
- **Vector retrieval over conversation history.** When `conversation_messages`
  passes ~500 rows for a given user, the 20-message window stops
  carrying enough. Backfill embeddings on a one-time migration; flip a
  feature flag in `conversation-send` to use vector search alongside the
  recency window.

## 1.2 — likely

- **Reminders + Things connector** for users who already track tasks
  there. Read-only sync into `tasks` so consolidation sees them.
- **Reflection prompts.** Lila proposes a reflection on a Sunday evening
  if the week had specific things worth marking down. Generated at the
  same moment as proactive candidates; surfaced in the home screen
  rather than as a push.
- **Web client.** Same protocol, different UI. Specifically not a chat
  interface — the home screen renders identically to iOS, conversation
  is also a pulled-up surface. The `lila-core` HTTP/SSE protocol is the
  contract; clients conform.

## Held — not on the roadmap

- **Engagement features.** Streaks, badges, daily check-ins, "you
  haven't opened Lila in 3 days" pushes. These are explicitly off the
  table in the spec and stay off here.
- **Marketing pushes.** Feature announcements, "tap to try X." Same.
- **Multi-modal capture.** Images, audio storage. The voice capture in
  iOS 1.0 is text transcription only; audio is never stored.
- **Multi-thread conversation.** One thread, forever. The constraint is
  load-bearing for the model's coherence; multiple threads make Lila
  legible at the cost of making her shallow.

## Working in this repo

If you're forking, the cleanest read is:

1. [README](./README.md) — the category claim.
2. [MANIFESTO](./MANIFESTO.md) — the longer essay it points to.
3. [ARCHITECTURE](./ARCHITECTURE.md) — the runtime, schema, and prompt split.
4. [CASE_STUDY](./CASE_STUDY.md) — one synthetic user's first day,
   end-to-end.
5. [`prompts/working-memory/`](./prompts/working-memory/) — the
   highest-leverage prompt in the system, in markdown for iteration.

Open issues and PRs welcome. The single-author posture of `CONTRIBUTING.md`
holds through 1.0; if that changes, this file changes first.
