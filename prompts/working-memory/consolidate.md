Update your working memory for {{first_name}}.

Today is {{current_date}}. The lookback window below covers the last
{{lookback_window_days}} days.

# Recent activity (chronological)

Each item has a `record` reference of the form `{table, id}`. When a bullet
in your output draws on a record, include that reference in `source_ids`.

```json
{{recent_activity_json}}
```

# Your working memory from the previous run

This is what you wrote yesterday. Carry forward what is still true. Drop
what has resolved. Update what has shifted. If this is null, this is the
first consolidation for this user.

```json
{{previous_working_memory_json}}
```

# Semantically retrieved memories

The top {{retrieved_memory_count}} memories from {{first_name}}'s long-term
store, ranked by salience and relevance to the recent activity above. Use
these to ground specifics — names, prior commitments, ongoing context —
that the recent activity alone does not explain.

```json
{{retrieved_memories_json}}
```

# Your task

Produce a single JSON object matching the schema below. No prose before or
after. No markdown fences. Just the object.

## focus_items — 0 to 4

What does {{first_name}} actually care about this week? Not their full task
list. The small set of things that, if you were physically standing next
to them as their assistant, you would want to keep in front of them.

Each item is one sentence, noun-led. Lead with the subject (the project,
the application, the decision, the time-bound commitment), then the state,
then the stake or deadline. No questions. No commands. No second-person.
Examples of the right shape (do not copy verbatim — these are for cadence only):

- "The Anthropic application — cover letter is in good shape; deadline Friday."
- "Lila TestFlight build, blocked on the Supabase schema migration."
- "Apartment lease decision with Jordan — they need an answer by next week."
- "Haircut at 2pm."
- "Pick up the kids tonight."

Selection priorities, in order:

1. **Time-bound commitments in the next 24 hours** belong here above
   anything else. A 2pm haircut beats an abstract project. The canonical
   focus_item is a specific, time-bound commitment, not a long-term idea.
2. **Specific commitments with named stakes or deadlines** in the next
   week.
3. **Active projects** with real next steps in the input.

A recurring meeting at its usual time is rarely a focus item. Surface it
only when something about *this* instance is unresolved — a one-off
agenda, a postponed decision, a new attendee. The standing 9am isn't on
Lila's mind; the 9am that just became a hiring loop is.

If a capture is too thin to write a meaningful bullet about — "reset
MacBook", "figure out X", a single phrase with no surrounding context —
drop it. "No context yet" is not a bullet; it is an admission that the
bullet should not exist. Sparse is honest. Two sharp items beat four soft
ones. Empty array is fine.

## people_threads — 0 to 2 people, 1 to 3 items each

Anyone {{first_name}} is in an active loop with where something is unresolved
on their side or the other person's? List the open items per person.

Skip this section entirely (empty array) if there is nothing genuinely
unresolved. A person they exchanged one message with does not have an open
thread. A person they owe a reply to, or who owes them one, does.

Calendar invitations, mass email, automated notifications, and digests do
not create threads. A thread requires an exchange where one side genuinely
owes the other a reply or a decision.

Each item is one sentence, written about the thread, not to the person.
Lead with what is owed or open — the person's name is the section header
and does not need to repeat in the bullet. Example: "Owes a response on
the Friday lunch invite."

## quiet_items — 0 to 4

Things {{first_name}} captured or committed to that have **not moved in at
least 10 days**, but that you do not think are dead. Surface them in a way
that invites a decision — revive, archive, or snooze — without nagging.

Hard rule: the most recent timestamp on any `source_id` for this item must
be **at least 10 calendar days before {{current_date}}**. A capture from
today or this week is not stalled, it is fresh. If you are tempted to
surface a fresh capture as a quiet_item, drop it — its time will come.
Compute `last_active_at` from the actual source timestamp; do not estimate.

Skip noise: completed tasks, idle tabs, things they explicitly said they
were dropping. The bar is "they would probably want to be reminded of this
without being told they failed at it."

Each item is one sentence. Soft framing. A trailing question is allowed
here (and only here) when it invites a decision rather than nags. Example:
"The podcast idea from March hasn't moved — still worth keeping warm?"

## greeting_context — usually null

A short phrase, only if something significant just shifted in their life:
returning from time away, a project just shipped, a major decision just
landed, a hard week just ended. Otherwise null.

Examples (only when warranted): "first day back from break", "the week
after the launch", "first morning since the Anthropic offer".

Most days this is null. When it appears, it should land. If you are not
sure whether it should appear, it should not.

# Output schema

```json
{
  "greeting_context": "string or null",
  "focus_items": [
    {
      "text": "string",
      "source_ids": [{ "table": "string", "id": "string" }],
      "salience": "number between 0 and 1"
    }
  ],
  "people_threads": [
    {
      "person": "string",
      "items": [
        {
          "text": "string",
          "source_ids": [{ "table": "string", "id": "string" }]
        }
      ]
    }
  ],
  "quiet_items": [
    {
      "text": "string",
      "source_ids": [{ "table": "string", "id": "string" }],
      "last_active_at": "ISO 8601 date string"
    }
  ]
}
```

`salience` is your own judgment of how load-bearing the item is — 1.0 is
"the user would be upset if this fell off the screen", 0.3 is "worth
mentioning, easily deferred". Sort focus_items descending by salience.

`last_active_at` for quiet_items is the most recent timestamp on any
source record for that item.

Output the JSON object now.
