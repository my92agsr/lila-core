# Case Study — Capture → Consolidation → Home Render

A concrete walkthrough of one user's first day on Lila, end-to-end. Names
and content are synthetic; the schema, prompts, and sequencing are real.
This document is the "show, don't tell" companion to
[ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Tuesday morning

Matt signs in with Apple. Supabase issues a JWT; the `profiles` row gets
created with a stub `first_name = "Matt"` from Apple's identity payload.
Onboarding asks him to confirm his timezone (`America/New_York`) and drops
him on the home screen. Empty state:

> *Hi, Matt. Tell Lila what's on your mind — anything. Lila will start
> paying attention.*

He types into the capture field at the bottom of the screen:

> *"Need to send the cover letter to Anthropic by Friday — the recruiting
> contact is Sara M."*

iOS optimistically inserts a row into `captures`:

```sql
INSERT INTO captures (user_id, raw_text, shaped_status)
VALUES ('5f1…', 'Need to send the cover letter…', 'pending');
```

…and POSTs to `/capture/shape`. The Edge Function:

1. Calls `/capture/classify` (Haiku, ~150ms) — returns `task`.
2. Routes to `shape_task.ts` (Sonnet) — extracts:
   - `title`: *"Send cover letter to Anthropic"*
   - `first_step`: *"Open the draft and reread it once."*
   - `due_at`: 2026-05-09 (Friday)
   - `domain`: *anthropic application*
3. Inserts the shaped row into `tasks`, updates `captures.shaped_into_*`.

Total latency: ~1.6s. The toast on Matt's screen says **"Lila has it."**

He captures two more in quick succession over coffee:

- *"Megan's IEP meeting is Thursday at 3 — I want to ask Ms. Reyes about
  the new testing timeline."*
- *"Susanna and I should pick the bathroom tile this weekend. The slate
  felt cold underfoot last Saturday."*

Both round-trip the same way — IEP becomes a `task` with `due_at = Thursday
3pm` and `notes` carrying the question for Ms. Reyes; the bathroom tile
becomes a `task` plus a `memory` row (semantic, salience 0.6) capturing
*"Slate option felt cold underfoot — Saturday."*

## The third-capture moment

On the iOS side, an on-device counter increments on each save. When it
hits 3, the client fires `/memory/refresh` immediately rather than waiting
for the nightly cron. Spec §10.2 calls this the *"wait, what"* moment —
the home screen flips from empty state to a real working memory surface
within seconds.

The Edge Function loads:

- The 3 captures + 3 shaped tasks (last 7 days).
- The (empty) yesterday `working_memory` row.
- The top 20 salience-weighted memories (just the one new memory row).
- Today's events from `events` (none — Matt hasn't connected calendar yet).
- Last 20 conversation messages (none).

It composes the consolidation prompt — system prompt is voice rules
(`agent/voice.ts`) + the consolidation instruction set
(`prompts/consolidation.ts`); user prompt is the rendered context. It
calls Sonnet with `cache_control: ephemeral` on the system block so
subsequent runs hit the prompt cache.

Sonnet returns JSON conforming to
[`prompts/working-memory/schema.json`](./prompts/working-memory/schema.json):

```json
{
  "greeting_context": null,
  "focus_items": [
    {
      "text": "The Anthropic application — cover letter due Friday; Sara M. is the contact.",
      "source_ids": [{"table": "tasks", "id": "a1c…"}, {"table": "captures", "id": "9d2…"}],
      "salience": 0.85
    },
    {
      "text": "Megan's IEP meeting Thursday — you wanted to ask Ms. Reyes about the testing timeline.",
      "source_ids": [{"table": "tasks", "id": "b4f…"}],
      "salience": 0.78
    }
  ],
  "people_threads": [
    {
      "person": "Susanna",
      "items": [{
        "text": "the bathroom tile decision — slate felt cold underfoot last Saturday",
        "source_ids": [{"table": "tasks", "id": "c7e…"}, {"table": "memories", "id": "d3a…"}]
      }]
    }
  ],
  "quiet_items": [],
  "version": 1
}
```

The Edge Function:

1. Upserts this into `working_memory` (one-row-per-user, primary key
   `user_id`).
2. Logs to `consolidation_runs` (trigger `'manual'`, duration_ms ~3.2s,
   tokens_in ~2400, tokens_out ~430, success true).
3. Chains into `/memory/proactive-scan`. For a brand-new user with no
   active commitments, the scan returns an empty array. No proactive
   candidates inserted.

## What Matt sees

The iOS client's `WorkingMemoryViewModel` is subscribed to changes via
SwiftData cache invalidation. The home screen re-renders:

> **Good morning, Matt.**
>
> **This week, you're focused on:**
> - The Anthropic application — cover letter due Friday; Sara M. is the contact.
> - Megan's IEP meeting Thursday — you wanted to ask Ms. Reyes about the testing timeline.
>
> **Open with Susanna:** the bathroom tile decision — slate felt cold underfoot last Saturday.

He long-presses the IEP bullet. The receipts sheet slides up showing the
shaped `tasks` row plus the original `captures` row — a verifiable trail
from the rendered surface back to what he actually said.

He taps the bathroom-tile bullet. The conversation sheet pulls up. The
client POSTs a system_anchor to `/conversation/anchor` with the bullet's
`source_ids`, then opens an SSE stream to `/conversation/send` with the
implicit content "tell me about this." The Edge Function:

1. Resolves the source records — the `tasks` row + the `memories` row.
2. Builds the conversation prompt: voice rules + working memory snapshot
   + last 20 messages + the resolved anchor sources.
3. Streams Sonnet's reply back.

Within 400ms the first token arrives:

> *"You and Susanna haven't landed on the tile yet — you mentioned last
> Saturday that the slate option felt cold underfoot. Want to think through
> it now, or wait until you're with her?"*

When the stream finishes, the `done` SSE event carries the assistant
message's `source_ids` (copied from the anchor row). The iOS client
attaches them to the in-memory message and renders two small chips below
the reply: **Task** and **Memory** — both tappable, both routing to the
same source-expansion sheet.

## Tuesday night, 3am

Per `pg_cron`, `lila_nightly_consolidation_fanout()` fires across every
active user. Matt's row is regenerated. The cover-letter task is now
elevated (Friday is two days away); the IEP item gets a `greeting_context`
nudge ("Megan's meeting is Thursday — anything you want to prep tonight?")
because the schema flagged it as imminent.

The proactive scan runs after consolidation. It generates one
`high_confidence` candidate: an event-imminent reminder for the IEP
meeting Thursday at 2:45pm. That row sits in `proactive_events` until
the every-5-min `proactive-deliver` worker reaches it Thursday afternoon,
checks rate limits and quiet hours, and pushes via APNs.

## Wednesday morning

Matt opens the app. The cached `working_memory` row renders instantly
from SwiftData. A background fetch quietly pulls the freshly-consolidated
row; if it's identical, the screen doesn't even flicker. The Anthropic
focus item is now phrased differently — Sonnet noticed the deadline
shortened.

This is the moment the spec is in service of: the home screen is the
model made visible, and the user didn't have to tell it anything except
what was on his mind.
