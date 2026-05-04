// Supabase IO for the working-memory pipeline. Reads recent rows for one
// user from the source tables (captures, tasks, reflections, messages,
// events), reads the previous working_memory row, and writes the new one.
//
// Uses the service-role key so it can read across users on behalf of a
// scheduled job. RLS still defends user data — this script is just allowed
// to bypass it because it's running server-side.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type {
  ConsolidationInput,
  ConsolidationOutput,
  RecentActivityItem,
} from './types.js'

export interface MakeClientArgs {
  url: string
  serviceRoleKey: string
}

export function makeServiceClient(args: MakeClientArgs): SupabaseClient {
  return createClient(args.url, args.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export interface LoadInputArgs {
  client: SupabaseClient
  userId: string
  firstName: string
  currentDate: string
  lookbackDays: number
}

export async function loadConsolidationInput(args: LoadInputArgs): Promise<ConsolidationInput> {
  const since = new Date(args.currentDate + 'T00:00:00Z')
  since.setUTCDate(since.getUTCDate() - args.lookbackDays)
  const sinceISO = since.toISOString()

  const [captures, tasks, reflections, messages, events, previous] = await Promise.all([
    fetchCaptures(args.client, args.userId, sinceISO),
    fetchTasks(args.client, args.userId, sinceISO),
    fetchReflections(args.client, args.userId, sinceISO),
    fetchMessages(args.client, args.userId, sinceISO),
    fetchEvents(args.client, args.userId, sinceISO),
    fetchPreviousWorkingMemory(args.client, args.userId),
  ])

  const recent_activity: RecentActivityItem[] = [
    ...captures,
    ...tasks,
    ...reflections,
    ...messages,
    ...events,
  ].sort((a, b) => a.ts.localeCompare(b.ts))

  return {
    first_name: args.firstName,
    current_date: args.currentDate,
    lookback_window_days: args.lookbackDays,
    previous_working_memory: previous,
    recent_activity,
    // Semantic retrieval against Supabase data is a separate phase. Empty
    // for now — the prompt handles an empty array fine.
    retrieved_memories: [],
  }
}

interface CaptureRow {
  id: string
  body: string
  created_at: string
}

async function fetchCaptures(
  client: SupabaseClient,
  userId: string,
  since: string,
): Promise<RecentActivityItem[]> {
  // Resolved captures are dropped: the user told Lila this is done.
  // Surfacing them as bullets after that is the "stuck haircut" bug.
  const { data, error } = await client
    .from('captures')
    .select('id, body, created_at')
    .eq('user_id', userId)
    .is('resolved_at', null)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []).map((row: CaptureRow) => ({
    record: { table: 'captures', id: row.id },
    kind: 'capture',
    ts: row.created_at,
    text: row.body,
  }))
}

interface TaskRow {
  id: string
  title: string
  status: string
  due_at: string | null
  created_at: string
  updated_at: string
}

async function fetchTasks(
  client: SupabaseClient,
  userId: string,
  since: string,
): Promise<RecentActivityItem[]> {
  // A task counts as activity if it was created or last touched in the window.
  const { data, error } = await client
    .from('tasks')
    .select('id, title, status, due_at, created_at, updated_at')
    .eq('user_id', userId)
    .or(`created_at.gte.${since},updated_at.gte.${since}`)
    .order('updated_at', { ascending: true })
  if (error) throw error
  return (data ?? []).map((row: TaskRow) => {
    const created = new Date(row.created_at).getTime()
    const updated = new Date(row.updated_at).getTime()
    const kind =
      row.status === 'done' ? 'task_completed'
      : updated - created > 60_000 ? 'task_updated'
      : 'task_created'
    return {
      record: { table: 'tasks', id: row.id },
      kind,
      ts: row.updated_at,
      title: row.title,
      status: row.status,
      due: row.due_at,
    }
  })
}

interface ReflectionRow {
  id: string
  content: string
  created_at: string
}

async function fetchReflections(
  client: SupabaseClient,
  userId: string,
  since: string,
): Promise<RecentActivityItem[]> {
  const { data, error } = await client
    .from('reflections')
    .select('id, content, created_at')
    .eq('user_id', userId)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []).map((row: ReflectionRow) => ({
    record: { table: 'reflections', id: row.id },
    kind: 'reflection',
    ts: row.created_at,
    text: row.content,
  }))
}

interface MessageRow {
  id: string
  person: string
  direction: 'in' | 'out'
  body: string
  created_at: string
}

async function fetchMessages(
  client: SupabaseClient,
  userId: string,
  since: string,
): Promise<RecentActivityItem[]> {
  const { data, error } = await client
    .from('messages')
    .select('id, person, direction, body, created_at')
    .eq('user_id', userId)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []).map((row: MessageRow) => ({
    record: { table: 'messages', id: row.id },
    kind: row.direction === 'in' ? 'message_received' : 'message_sent',
    ts: row.created_at,
    from: row.direction === 'in' ? row.person : undefined,
    text: row.body,
  }))
}

interface EventRow {
  id: string
  title: string
  start_at: string
  end_at: string | null
  created_at: string
  attendees: string[] | null
  location: string | null
}

async function fetchEvents(
  client: SupabaseClient,
  userId: string,
  since: string,
): Promise<RecentActivityItem[]> {
  // Events count if they were scheduled (created) in the window OR happen
  // inside the window — the second case keeps "your 2pm tomorrow" on Lila's
  // radar even if it was added a month ago.
  const { data, error } = await client
    .from('events')
    .select('id, title, start_at, end_at, created_at, attendees, location')
    .eq('user_id', userId)
    .or(`created_at.gte.${since},start_at.gte.${since}`)
    .order('start_at', { ascending: true })
  if (error) throw error
  return (data ?? []).map((row: EventRow) => {
    const item: RecentActivityItem = {
      record: { table: 'events', id: row.id },
      kind: 'event',
      ts: row.start_at,
      title: row.title,
      starts_at: row.start_at,
      ends_at: row.end_at,
    }
    // Omit empty/null attendee+location rather than serializing nulls into
    // the prompt — the model treats absent fields as "not applicable",
    // which is what we mean here.
    if (row.attendees && row.attendees.length > 0) item.attendees = row.attendees
    if (row.location) item.location = row.location
    return item
  })
}

interface WorkingMemoryRow {
  greeting_context: string | null
  focus_items: ConsolidationOutput['focus_items']
  people_threads: ConsolidationOutput['people_threads']
  quiet_items: ConsolidationOutput['quiet_items']
}

async function fetchPreviousWorkingMemory(
  client: SupabaseClient,
  userId: string,
): Promise<ConsolidationOutput | null> {
  const { data, error } = await client
    .from('working_memory')
    .select('greeting_context, focus_items, people_threads, quiet_items')
    .eq('user_id', userId)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const row = data as WorkingMemoryRow
  return {
    greeting_context: row.greeting_context,
    focus_items: row.focus_items ?? [],
    people_threads: row.people_threads ?? [],
    quiet_items: row.quiet_items ?? [],
  }
}

export interface WriteOutputArgs {
  client: SupabaseClient
  userId: string
  output: ConsolidationOutput
}

export async function writeWorkingMemory(args: WriteOutputArgs): Promise<{ id: string; generated_at: string }> {
  const { data, error } = await args.client
    .from('working_memory')
    .insert({
      user_id: args.userId,
      greeting_context: args.output.greeting_context,
      focus_items: args.output.focus_items,
      people_threads: args.output.people_threads,
      quiet_items: args.output.quiet_items,
    })
    .select('id, generated_at')
    .single()
  if (error) throw error
  return data as { id: string; generated_at: string }
}

export interface ResolveUserArgs {
  client: SupabaseClient
  userIdOrEmail: string
}

// Accept either a uuid or an email; admin endpoint resolves the email.
export async function resolveUserId(args: ResolveUserArgs): Promise<string> {
  if (UUID_RE.test(args.userIdOrEmail)) return args.userIdOrEmail
  const email = args.userIdOrEmail
  // listUsers paginates; the client's first page is plenty for personal scale.
  const { data, error } = await args.client.auth.admin.listUsers({ page: 1, perPage: 200 })
  if (error) throw error
  const match = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
  if (!match) throw new Error(`No auth.users row matches ${email}`)
  return match.id
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
