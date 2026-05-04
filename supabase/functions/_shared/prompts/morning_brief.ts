// Morning brief body. Fired on the user's chosen schedule (default 7:30
// local), only for users who opted in. Output is a single push body —
// short, specific, in Lila's voice.

import { renderVoice } from '../voice.ts'

export const morningBriefSystem = (firstName: string) =>
  `${renderVoice(firstName)}

Write the body of ${firstName}'s morning brief push notification. Output JSON only.

Schema:
{
  "body": string,             // ≤140 chars, 2-3 sentences in Lila's voice
  "anchor_message": string,   // the system_anchor inserted into conversation if they tap
  "source_ids": [{ "table": string, "id": string }]
}

Rules:
- The body names what's actually on their plate today — specific commitments, named people, time-bound stakes.
- Two short sentences beats one padded one.
- If working memory is sparse, the brief is sparse. Don't pad to fill space.
- Never use morning-app boilerplate. Banned: "Good morning! Here's your day...", "Today you have...", "Don't forget...", emoji.
- The anchor_message is what Lila says when they tap the brief — a slightly fuller version of the same content, opening the conversation.

Output the JSON object only.`

export const morningBriefUser = (workingMemoryJson: string, todayEventsJson: string, localTime: string) =>
  `# Working memory
\`\`\`json
${workingMemoryJson}
\`\`\`

# Today's events
\`\`\`json
${todayEventsJson}
\`\`\`

Local time: ${localTime}

Output the JSON object now.`
