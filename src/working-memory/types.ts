// Shared types for the working-memory consolidation pipeline.
//
// `ConsolidationInput` matches what the consolidate.md prompt expects.
// `ConsolidationOutput` matches schema.json — also the shape of the
// Supabase `working_memory` row (jsonb columns + generated_at).

export interface SourceRef {
  table: string
  id: string
}

export interface RecentActivityItem {
  record: SourceRef
  kind: string
  ts: string
  // Free-form payload — the prompt reads whichever of these are present.
  text?: string
  title?: string
  status?: string
  due?: string | null
  note?: string
  from?: string
  starts_at?: string
  ends_at?: string | null
  attendees?: string[]
  location?: string | null
}

export interface RetrievedMemory {
  ts: string
  salience: number
  text: string
}

export interface ConsolidationInput {
  first_name: string
  current_date: string
  lookback_window_days: number
  previous_working_memory: ConsolidationOutput | null
  recent_activity: RecentActivityItem[]
  retrieved_memories: RetrievedMemory[]
}

export interface FocusItem {
  text: string
  source_ids: SourceRef[]
  salience: number
}

export interface PersonThreadItem {
  text: string
  source_ids: SourceRef[]
}

export interface PersonThread {
  person: string
  items: PersonThreadItem[]
}

export interface QuietItem {
  text: string
  source_ids: SourceRef[]
  last_active_at: string
}

export interface ConsolidationOutput {
  greeting_context: string | null
  focus_items: FocusItem[]
  people_threads: PersonThread[]
  quiet_items: QuietItem[]
}
