# Working Memory Example

This is what Lila Core actually produces. The example below is one
consolidated `working_memory` row — synthetic, but structurally
identical to what a real user gets after a few weeks of capturing.

The user typed eight things across two weeks: a few quick captures
during the day, a phone call summary at 11pm Tuesday, a calendar event
they snoozed twice, a note they meant to come back to. They never
filed any of it. They never tagged anything. The system kept a model.

## What the home screen renders

> **This week, you're focused on:** the cover letter (due Friday),
> Megan's IEP meeting Thursday, the basement radon retest.
>
> **Open with Susanna:** the bathroom tile decision, the weekend with
> her parents.
>
> **Quiet but not forgotten:** the Third Period Labs outreach you
> captured 17 days ago.

Each line is tappable. Tapping a bullet seeds a new conversation
anchored to the source rows behind that bullet — the original capture,
the calendar event, the note. The conversation can pull in everything
the system knows; it doesn't start cold.

## The underlying record

This is the JSON the consolidation writes back to the
`working_memory` table. The schema lives at
[`prompts/working-memory/schema.json`](./prompts/working-memory/schema.json).

```json
{
  "greeting_context": null,
  "focus_items": [
    {
      "text": "The cover letter for the Director of Programs role — draft due Friday. Deferred twice.",
      "source_ids": [
        { "table": "captures", "id": "cap_8f2a1c" },
        { "table": "captures", "id": "cap_a4b9d3" },
        { "table": "tasks",    "id": "tsk_3e718c" }
      ],
      "salience": 0.92
    },
    {
      "text": "Megan's IEP meeting Thursday 10:30am. School has not confirmed the OT eval results yet.",
      "source_ids": [
        { "table": "events",   "id": "evt_19fb04" },
        { "table": "captures", "id": "cap_77c213" }
      ],
      "salience": 0.88
    },
    {
      "text": "Basement radon retest — original kit reading was 4.2 pCi/L. Retest scheduled for next week.",
      "source_ids": [
        { "table": "captures", "id": "cap_55ae90" },
        { "table": "tasks",    "id": "tsk_b7c441" }
      ],
      "salience": 0.71
    }
  ],
  "people_threads": [
    {
      "person": "Susanna",
      "items": [
        {
          "text": "Bathroom tile decision still open — she sent two options Sunday, you didn't reply.",
          "source_ids": [
            { "table": "messages", "id": "msg_2bc009" },
            { "table": "captures", "id": "cap_f10aa1" }
          ]
        },
        {
          "text": "Weekend with her parents — she's leaning yes, you said you'd think about it.",
          "source_ids": [
            { "table": "messages", "id": "msg_77df21" }
          ]
        }
      ]
    }
  ],
  "quiet_items": [
    {
      "text": "Third Period Labs outreach — drafted intro to David, never sent.",
      "source_ids": [
        { "table": "captures", "id": "cap_19ab02" },
        { "table": "notes",    "id": "nt_6c3aa8"  }
      ],
      "last_active_at": "2026-04-15T22:11:00Z"
    }
  ]
}
```

## How it was produced

The consolidation ran at 3am the user's local time. It read the recent
windows of the `captures`, `tasks`, `events`, `messages`, `notes`, and
`reflections` tables — RLS-scoped to the single user. It applied the
voice rules in
[`supabase/functions/_shared/voice.ts`](./supabase/functions/_shared/voice.ts)
and the structure prompt in
[`supabase/functions/_shared/prompts/consolidation.ts`](./supabase/functions/_shared/prompts/consolidation.ts).
Output was validated against
[`prompts/working-memory/schema.json`](./prompts/working-memory/schema.json),
written into the `working_memory` row for that user, and chained
straight into the proactive scan, which decided not to push anything
this morning — the IEP meeting is still 36 hours out.

## Why source receipts matter

Every bullet carries `source_ids`. When the user taps the cover-letter
line on the home screen, the iOS sheet resolves the three referenced
rows and shows them — the two captures where they mentioned it, and
the task that was created when they first said "I should write that."
A user can always trace what the system noticed back to what they
actually said. There is nothing the system claims that the user can't
verify.

This is the thing chat-app "memory features" don't have.

## What the prompt does *not* do

- It doesn't pad. If the user only has two real focus items this week,
  the array has two items. Empty `quiet_items` is a valid output.
- It doesn't generate tasks. It surfaces what's actually unresolved.
- It doesn't second-person address the user inside the bullets — voice
  rules ban "you should." The voice is observational.
- It doesn't reach further than ~14 days back unless `last_active_at`
  on a quiet item demands it.

The prompts are open. Read them. Fork them.
