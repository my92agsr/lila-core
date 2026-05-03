# ADR-002 — One continuous conversation per user

**Status:** Accepted · **Date:** 2026-05

## Context

Every chat product treats conversations as discrete sessions. New
chat, new context, new "what would you like help with today?" The user
is responsible for remembering what was said in the last session,
what the assistant already knows, and what context to re-paste at the
top of the new thread.

That model fights the [manifesto](../MANIFESTO.md). The whole point
of an attention layer is that it holds the model of what matters
across time. If the user has to start a new conversation every time
they want to talk to it, the system isn't actually paying attention —
it's responding.

## Decision

Lila Core ships **one continuous conversation per user**, not a list
of sessions. The conversation is anchored to the working-memory row;
when the home screen renders a bullet, tapping it seeds the same
ongoing thread with the bullet's source rows already in context.
Memory carries day-to-day. The user never starts over.

## Why

1. **The home screen is the entry point, not a chat picker.** The
   attention-layer surface is what the system noticed. The
   conversation is the affordance for going deeper on any of it. A
   list of past chats would compete with the home screen for the
   user's attention, and the home screen is supposed to win.

2. **Continuity is the product.** "I told you about that thing two
   weeks ago" is a sentence the user should never have to say. With
   one continuous conversation backed by the working-memory layer,
   they don't.

3. **It removes a class of UI decisions we don't want to make.**
   Naming conversations. Listing them. Search across them. Pinning
   them. Archiving them. Every one of those is a productivity-app
   decision, and Lila is not a productivity app.

## Consequences

- The conversation can grow large. Sonnet's context window plus
  prompt caching on the system prompt makes this manageable for a
  long time, but eventually we'll need a strategy for long-thread
  summarization. The plan: a per-user `conversation_summary` row that
  the consolidation maintains, replacing oldest turns in the live
  window. That work is queued for 1.1+.
- "Anchor" is a first-class operation. Tapping a bullet calls
  `POST /conversation/anchor`
  ([`supabase/functions/conversation-anchor`](../supabase/functions/conversation-anchor/))
  which seeds the next user turn with the source rows already loaded
  — not a new thread, a new turn with context.
- Users who want to "start fresh" cannot. That's a deliberate
  trade-off. The conversation is a thread the system is having with
  them; the system isn't supposed to forget the thread because the
  user wanted a clean room.

## Revisit when

- Average per-user conversation length crosses a threshold where
  prompt-caching no longer keeps latency tolerable.
- A real user request — not a hypothesis about user behavior — surfaces
  a need to maintain multiple parallel threads (e.g. work vs. personal
  separation that the home screen doesn't already handle).
