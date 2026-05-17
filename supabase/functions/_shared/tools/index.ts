// Conversation tools — the chief-of-staff verbs.
//
// When Lila is mid-conversation, she can act on the substrate instead of
// just describing what to do. Each tool here is:
//   - RLS-scoped via scopedSupabase(userId) — user can only touch their own rows.
//   - Idempotent or safely re-runnable.
//   - Auditable: every call is persisted into conversation_messages.tool_calls
//     so the user can see exactly what Lila did and undo if needed.
//
// Posture: low-stakes verbs auto-execute; the model acts and then says what
// it did. No confirmation prompts. Higher-stakes verbs (send email, delete)
// don't live here — those land behind explicit user UI, not behind a model.
//
// Each tool exposes:
//   - definition: the Anthropic tool spec sent in messages.stream({ tools })
//   - execute(input, sb): runs the action, returns a structured result
//
// `result.summary` is a one-line, voice-aligned phrase the model can quote
// back ("marked the cover letter done"). `result.status` is 'ok' or 'error'.

import type { ScopedSupabase } from '../scopedSupabase.ts'

export type ToolStatus = 'ok' | 'error'

export interface ToolResult {
  status: ToolStatus
  summary: string
  // Optional structured payload — not currently surfaced to the model
  // beyond the summary string, but stored on tool_calls for client UIs.
  data?: Record<string, unknown>
}

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
  execute: (input: any, sb: ScopedSupabase) => Promise<ToolResult>
}

// Layer enum mirrors the schema constraint on tasks.layer.
const LAYERS = ['today', 'current', 'horizon'] as const

const markTaskResolved: ToolDefinition = {
  name: 'mark_task_resolved',
  description:
    'Mark a task as done. Use when the user states or confirms something is finished — "I sent it", "done", "took care of that". Sets resolved_at to now. Idempotent.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'UUID of the task to resolve.' },
      title_hint: {
        type: 'string',
        description: 'Optional human-readable title fragment, used only for the summary line.',
      },
    },
    required: ['task_id'],
  },
  async execute(input, sb) {
    const taskId = String(input.task_id ?? '')
    if (!taskId) return { status: 'error', summary: 'task_id is required' }
    const { data, error } = await sb.from('tasks')
      .update({ resolved_at: new Date().toISOString() })
      .eq('id', taskId)
      .select('id, title')
      .maybeSingle()
    if (error) return { status: 'error', summary: `couldn't mark task done: ${error.message}` }
    if (!data) return { status: 'error', summary: 'task not found' }
    const label = input.title_hint || data.title || 'the task'
    return { status: 'ok', summary: `marked "${label}" done`, data: { task_id: data.id } }
  },
}

const updateTask: ToolDefinition = {
  name: 'update_task',
  description:
    'Edit an existing task. Use when the user clarifies a first step, shifts a due date, demotes/promotes priority (layer), or adds a note. Only the fields you pass are changed.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      first_step: { type: 'string', description: 'Concrete next physical action.' },
      due_at: { type: 'string', description: 'ISO 8601 timestamp; null to clear.' },
      layer: { type: 'string', enum: [...LAYERS] },
      notes: { type: 'string' },
      title: { type: 'string' },
    },
    required: ['task_id'],
  },
  async execute(input, sb) {
    const taskId = String(input.task_id ?? '')
    if (!taskId) return { status: 'error', summary: 'task_id is required' }
    const patch: Record<string, unknown> = {}
    if (typeof input.first_step === 'string') patch.first_step = input.first_step
    if (typeof input.notes === 'string') patch.notes = input.notes
    if (typeof input.title === 'string') patch.title = input.title
    if (typeof input.layer === 'string' && (LAYERS as readonly string[]).includes(input.layer)) {
      patch.layer = input.layer
    }
    if ('due_at' in input) {
      patch.due_at = input.due_at === null ? null : String(input.due_at)
    }
    if (Object.keys(patch).length === 0) {
      return { status: 'error', summary: 'no fields to update' }
    }
    patch.updated_at = new Date().toISOString()
    const { data, error } = await sb.from('tasks')
      .update(patch)
      .eq('id', taskId)
      .select('id, title')
      .maybeSingle()
    if (error) return { status: 'error', summary: `couldn't update task: ${error.message}` }
    if (!data) return { status: 'error', summary: 'task not found' }
    const fields = Object.keys(patch).filter((k) => k !== 'updated_at').join(', ')
    return {
      status: 'ok',
      summary: `updated "${data.title}" (${fields})`,
      data: { task_id: data.id, fields: Object.keys(patch).filter((k) => k !== 'updated_at') },
    }
  },
}

const createReflection: ToolDefinition = {
  name: 'create_reflection',
  description:
    'Save a reflection from the current conversation. Use sparingly — when the user says something worth marking down ("I think the real reason was...", "looking back, what mattered was..."), or asks Lila to write a reflection. Do not use for every message.',
  input_schema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The reflection text, in the user\'s voice.' },
      kind: { type: 'string', enum: ['daily', 'weekly', 'ad_hoc'], description: 'Defaults to ad_hoc.' },
    },
    required: ['content'],
  },
  async execute(input, sb) {
    const content = String(input.content ?? '').trim()
    if (!content) return { status: 'error', summary: 'content is required' }
    const kind = ['daily', 'weekly', 'ad_hoc'].includes(input.kind) ? input.kind : 'ad_hoc'
    const { data, error } = await sb.from('reflections')
      .insert({ content, kind })
      .select('id')
      .single()
    if (error) return { status: 'error', summary: `couldn't save reflection: ${error.message}` }
    return { status: 'ok', summary: 'saved a reflection', data: { reflection_id: data.id } }
  },
}

const correctMemory: ToolDefinition = {
  name: 'correct_memory',
  description:
    'Fix a memory item that is wrong or stale. Use when the user explicitly corrects a fact ("no, it was Tuesday, not Thursday"; "I prefer X, not Y now"). Pass new_content to rewrite, new_salience to up- or down-weight.',
  input_schema: {
    type: 'object',
    properties: {
      memory_id: { type: 'string' },
      new_content: { type: 'string' },
      new_salience: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Salience between 0 and 1.',
      },
    },
    required: ['memory_id'],
  },
  async execute(input, sb) {
    const memoryId = String(input.memory_id ?? '')
    if (!memoryId) return { status: 'error', summary: 'memory_id is required' }
    const patch: Record<string, unknown> = {}
    if (typeof input.new_content === 'string' && input.new_content.trim()) {
      patch.content = input.new_content.trim()
    }
    if (typeof input.new_salience === 'number') {
      patch.salience = Math.max(0, Math.min(1, input.new_salience))
    }
    if (Object.keys(patch).length === 0) {
      return { status: 'error', summary: 'nothing to change' }
    }
    const { data, error } = await sb.from('memories')
      .update(patch)
      .eq('id', memoryId)
      .select('id')
      .maybeSingle()
    if (error) return { status: 'error', summary: `couldn't correct memory: ${error.message}` }
    if (!data) return { status: 'error', summary: 'memory not found' }
    return { status: 'ok', summary: 'corrected the memory', data: { memory_id: data.id } }
  },
}

const ALL: ToolDefinition[] = [markTaskResolved, updateTask, createReflection, correctMemory]
const BY_NAME = new Map(ALL.map((t) => [t.name, t]))

// Anthropic tool specs — what we send in messages.stream({ tools }).
export const TOOL_SPECS = ALL.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}))

export async function executeTool(
  name: string,
  input: unknown,
  sb: ScopedSupabase,
): Promise<ToolResult> {
  const def = BY_NAME.get(name)
  if (!def) return { status: 'error', summary: `unknown tool: ${name}` }
  try {
    return await def.execute(input ?? {}, sb)
  } catch (err: any) {
    return { status: 'error', summary: err?.message ?? 'tool execution failed' }
  }
}
