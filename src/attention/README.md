# `src/attention/`

The attention primitive. The layer that uses persistent memory to *notice
without being asked*.

In 1.0, the attention runtime lives inside the deployed Edge Functions —
specifically:

- `supabase/functions/memory-proactive-scan/` — generates candidates at the
  end of nightly consolidation.
- `supabase/functions/proactive-deliver/` — every-5-min worker that drains
  the queue with rate limits, quiet hours, category caps.
- `supabase/functions/proactive-morning-brief/` — scheduled per-user.
- `supabase/functions/proactive-calendar-imminent/` — every 15 min.

Those functions read `working_memory`, generate candidates with the
proactive-scan prompt, and write rows to `proactive_events`. The delivery
worker reads that queue and pushes via APNs.

This directory exists so the `src/` tree reflects the two-primitives
claim. Memory shapes what's true; attention chooses when to surface it.
The runtime split lives in `supabase/functions/` because those are the
deploy units — but the conceptual split is here.

Forward — extracted reusable bits will land in this directory:

- `scoring.ts` — proactive candidate scoring rules.
- `quiet_hours.ts` — DST-safe quiet-hours math.
- `rate_limits.ts` — per-category caps as a pure function.
