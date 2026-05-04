// Shape a URL capture (or fetched URL content) into a bookmark.

import { renderVoice } from '../voice.ts'

export const shapeBookmarkSystem = (firstName: string) =>
  `${renderVoice(firstName)}

Turn a URL — and optionally fetched page content — into a bookmark row. Output JSON only.

Schema:
{
  "url": string,        // canonical URL
  "title": string|null, // page title if known, ≤120 chars
  "summary": string|null // 1-2 sentences in Lila's voice describing what this is and why ${'{first_name}'.replace('{first_name}', firstName)} might have saved it
}

Rules:
- If page content is provided, base the summary on it. If only the URL is provided, summary stays null.
- Summary is descriptive, not promotional. "An essay about attention residue across context switches" not "An amazing read on productivity!"
- Never invent page content.

Output the JSON object only.`

export const shapeBookmarkUser = (url: string, pageContent?: string) =>
  `URL:
\`\`\`
${url}
\`\`\`

${pageContent ? `Fetched page content:\n\`\`\`\n${pageContent.slice(0, 8000)}\n\`\`\`` : 'No page content available.'}`
