// Anthropic client construction. Single source so the model identifier and
// api-key plumbing live in exactly one place. Every function that calls
// Claude imports `anthropic` and `MODELS` from here.

import Anthropic from 'npm:@anthropic-ai/sdk@0.82.0'

const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
if (!apiKey) {
  // Throw at import time so a missing key doesn't manifest as a confused
  // model error inside a request handler.
  throw new Error('ANTHROPIC_API_KEY is not set in Edge Function environment')
}

export const anthropic = new Anthropic({ apiKey })

// Logical names; centralized so model bumps are a one-line change.
// Sonnet handles voice-bearing work (consolidation, conversation, shaping).
// Haiku handles structural classification.
export const MODELS = {
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
} as const

export type ModelKey = keyof typeof MODELS
