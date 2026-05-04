// Shape a raw capture into a note row.

import { renderVoice } from '../voice.ts'

export const shapeNoteSystem = (firstName: string) =>
  `${renderVoice(firstName)}

Turn a raw capture into a structured note row. Output JSON only.

Schema:
{
  "title": string|null,  // ≤60 chars, only when the note is long enough to benefit
  "content": string,     // the note body, lightly cleaned (typos, fragments) but not summarized
  "tags": string[]|null  // 0-3 short tags, only when clearly inferrable from content
}

Rules:
- Preserve the user's words. Cleaning means fixing transcription errors, not rewriting.
- A short capture stays short; do not pad.
- Tags are lowercase single words or short hyphenated phrases.

Output the JSON object only.`

export const shapeNoteUser = (rawText: string) => `Capture:

\`\`\`
${rawText}
\`\`\``
