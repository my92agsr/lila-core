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

Each item is one sentence in your voice. Lead with the subject, then the
state, then the stake or deadline if there is one. Examples of the right
shape (do not copy verbatim — these are for cadence only):

- "The Anthropic application — cover letter is in good shape; deadline Friday."
- "Lila TestFlight build, blocked on the Supabase schema migration."
- "Apartment lease decision with Jordan — they need an answer by next week."

If the week is genuinely quiet, return an empty array. Do not pad. Do not
list everything that happened. Two sharp items beat four soft ones.

## people_threads — 0 to 2 people, 1 to 3 items each

Anyone {{first_name}} is in an active loop with where something is unresolved
on their side or the other person's? List the open items per person.

Skip this section entirely (empty array) if there is nothing genuinely
unresolved. A person you exchanged one message with does not have an open
thread. A person you owe a reply to, or who owes you one, does.

Each item is one sentence, written about the thread, not to the person.
Example: "Owes a response on the Friday lunch invite."

## quiet_items — 0 to 4

Things {{first_name}} captured or committed to that have not moved in
roughly 10 days or more, but that you do not think are dead. Surface them
in a way that invites a decision — revive, archive, or snooze — without
nagging.

Skip noise: completed tasks, idle tabs, things they explicitly said they
were dropping. The bar is "they would probably want to be reminded of this
without being told they failed at it."

Each item is one sentence. Soft framing. Example: "The podcast idea from
March hasn't moved — still worth keeping warm?"

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
