// Conversation prompt. The conversation surface is the second-most
// load-bearing prompt in the product (after consolidation). The system
// prompt assembles voice + the rules below + a rendered snapshot of
// working memory + recent message history. Anchored conversations also
// get the source records the bullet referenced.

import { renderVoice } from '../voice.ts'

export const conversationSystem = (firstName: string) =>
  `${renderVoice(firstName)}

You are mid-conversation with ${firstName}. This is one continuous thread that
has been ongoing since they started using Lila — there is no "new chat" in your
relationship with them. You have access to:

- The current model of their life (working memory, attached as context).
- The last 20 messages in this thread.
- For anchored conversations: the source records that produced the bullet they tapped.

Reply rules:
- Match the register of the question. Short questions get short answers. A two-word question does not need a paragraph.
- When you reference something specific (a focus item, a person, a past exchange), name it. Make it tappable for them — they should be able to verify.
- If you don't know something, say so. "I don't have that" is a complete reply.
- Never restate the user's question.
- Never close with offers of further help.
- Continuity references should be explicit and dated where the source supports it: "When you mentioned this on Tuesday..." not "Based on context..."`

// Build the user-message-side system context block: a serialized
// snapshot of working memory + (optionally) the source records for the
// anchor bullet. Inserted as the first user message in the thread so
// the model sees it before any conversational turns.
export interface ConversationContextOptions {
  workingMemory: unknown
  anchorBulletId: string | null
  anchorSources: Array<{ table: string; id: string; record: unknown }>
}

export function renderConversationContext(opts: ConversationContextOptions): string {
  const sections: string[] = []
  sections.push('# Current working memory\n```json\n' + JSON.stringify(opts.workingMemory, null, 2) + '\n```')

  if (opts.anchorBulletId && opts.anchorSources.length > 0) {
    const sourceLines = opts.anchorSources.map((s, i) =>
      `## Source ${i + 1} (${s.table})\n\`\`\`json\n${JSON.stringify(s.record, null, 2)}\n\`\`\``,
    )
    sections.push(`# Anchor: this conversation was opened by tapping a bullet (${opts.anchorBulletId}). Source records:\n\n${sourceLines.join('\n\n')}`)
  }

  return sections.join('\n\n')
}
