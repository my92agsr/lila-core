# ADR-001 — No pgvector retrieval in 1.0

**Status:** Accepted · **Date:** 2026-05

## Context

A persistent-memory runtime is the kind of system every reader assumes
must be doing dense-vector retrieval over the user's history. Most
"memory" features in chat products are RAG pipelines: embed every
message, store the vectors, fetch the nearest neighbors at query time,
inject them into context.

Lila Core's working-memory layer does not work that way in 1.0. The
schema is designed to be forward-compatible with vector retrieval, and
the column space is reserved, but the 1.0 deployment does not run
pgvector and does not embed captures.

## Decision

Memory retrieval in 1.0 is **structured, recency-windowed, and prompted**:
the consolidator pulls a bounded recent window from typed Postgres
tables (captures, tasks, events, messages, notes, reflections), folds
in any long-term distilled-memory rows, and asks Sonnet to produce the
working-memory record from that bundle. Source receipts come from the
typed row IDs, not from a vector store.

## Why

Three reasons.

1. **The hard problem isn't retrieval — it's consolidation.** The thing
   most chat-app memory features get wrong is not what they fetch; it's
   what they decide to *remember*. Salience scoring, source-stamped
   provenance, and noticing what's quiet but not dead are all
   consolidation problems. They happen at write time, not at read
   time. Adding vector retrieval to a system that hasn't solved the
   write-side problem just retrieves more noise faster.

2. **Sonnet's context window is enough.** A bounded recent window of
   typed rows fits comfortably. We don't need similarity search to get
   the right captures into context — we already know which rows are
   recent and we already know what type they are. The structure of the
   data carries most of the retrieval work that vectors are usually
   asked to do.

3. **Vector pipelines are operationally heavy and easy to break.**
   Embedding drift, re-embedding cost on prompt changes, dimension
   mismatches between providers, hot-vector skew — all real costs that
   pay off only when you have a clear retrieval problem the structure
   isn't already solving.

## Consequences

- The `working_memory` row is reproducible from the underlying typed
  rows alone. No vector index to keep consistent. No embedding job.
- We can add pgvector later without a schema migration: an embeddings
  table joined on capture id, and an opt-in "deep recall" branch in
  the consolidation prompt. The forward-compatible columns are already
  reserved.
- We do not currently support "semantic recall" of captures older than
  the recency window. If a user asks the conversation about something
  from six months ago, the system has it only if it was distilled into
  a long-term memory record. That's an acceptable 1.0 limitation given
  the cost and complexity of getting it right at scale.

## Revisit when

- The consolidation quality plateaus and the next obvious improvement
  is "the model needs more of the user's history."
- A specific user request demands recall outside the recency window.
- The cost of running a small Sonnet pass over the full typed window
  becomes uncompetitive with embedding-based retrieval.
