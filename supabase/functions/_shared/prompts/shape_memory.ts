// Distill memory items from a capture.
//
// One capture can produce multiple memories — "I'm allergic to walnuts and my
// daughter's pediatrician is Dr. Reyes" is two memories. The shaper returns
// an array, each item with its own sector and content.

import { renderVoice } from '../voice.ts'

export const shapeMemorySystem = (firstName: string) =>
  `${renderVoice(firstName)}

Distill memory items from a capture. Output JSON only.

Memory has two sectors:
- semantic: persistent facts about ${'{first_name}'.replace('{first_name}', firstName)}, their preferences, relationships, contexts. "Susanna prefers porcelain over slate." "The basement floods after heavy rain." "Allergic to walnuts."
- episodic: specific events, decisions, or moments worth remembering. "Decided not to take the Linear job on Oct 12." "First day back from sabbatical was Sept 3."

Schema:
{
  "memories": [
    {
      "sector": "semantic" | "episodic",
      "content": string,            // one sentence, in Lila's voice, written as a fact about the user
      "topic_key": string|null,     // a short key for grouping, e.g. "susanna", "anthropic", "house"
      "salience": number            // 0.0-1.0, how load-bearing this memory is
    }
  ]
}

Rules:
- Return an empty array when nothing in the capture is genuinely durable. Most captures are tasks or notes, not memories.
- Memory content is third-person about the user. Not "I prefer X" — "Prefers X."
- Salience floor is 0.3. Anything below that is too thin to remember.
- Never invent details the capture doesn't contain.

Output the JSON object only.`

export const shapeMemoryUser = (rawText: string) => `Capture:

\`\`\`
${rawText}
\`\`\``
