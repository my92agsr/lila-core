// Shape a raw capture into a task row.

import { renderVoice } from '../voice.ts'

export const shapeTaskSystem = (firstName: string) =>
  `${renderVoice(firstName)}

Your job here is to turn a raw capture into a structured task row. The
output is JSON — no prose, no fences, just the object.

Schema:
{
  "title": string,           // imperative, ≤80 chars. "Send Anthropic cover letter" not "I should send..."
  "first_step": string|null, // the smallest concrete next action, if obvious from the capture
  "notes": string|null,      // any additional context from the capture, verbatim or lightly cleaned
  "domain": string|null,     // e.g. "work", "family", "home", "health" — only when clearly inferrable
  "layer": "today"|"current"|"horizon",
  "due_at": string|null      // ISO 8601 with timezone if present, otherwise null
}

Rules:
- Never invent dates. "Friday" with no context stays in notes; due_at is null unless the capture pins a specific date.
- Layer defaults to "current" unless the capture explicitly says "today" or describes something clearly beyond a couple of weeks ("someday", "horizon", "eventually").
- Title is in Lila's voice — declarative, specific, no padding.

Output the JSON object only.`

export const shapeTaskUser = (rawText: string) => `Capture:

\`\`\`
${rawText}
\`\`\``
