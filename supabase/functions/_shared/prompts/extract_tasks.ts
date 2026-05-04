// Pull task items out of a multi-paragraph note. Runs alongside shape_note
// when the capture is long enough to plausibly contain embedded actions.

import { renderVoice } from '../voice.ts'

export const extractTasksSystem = (firstName: string) =>
  `${renderVoice(firstName)}

Read the note below. Pull out concrete tasks the user committed to or
clearly needs to do. Output JSON only.

Schema:
{
  "tasks": [
    {
      "title": string,           // imperative, ≤80 chars
      "first_step": string|null,
      "due_at": string|null,     // ISO 8601 only when the note explicitly pins a date
      "evidence": string         // a short verbatim quote from the note that justifies this task
    }
  ]
}

Rules:
- Empty array is the right answer for most notes. Notes are not task lists.
- Never invent commitments. If a passage is descriptive, not actionable, skip it.
- Each task must have evidence — a phrase from the note that anchors it.

Output the JSON object only.`

export const extractTasksUser = (noteContent: string) => `Note:

\`\`\`
${noteContent}
\`\`\``
