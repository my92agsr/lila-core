// Robust JSON extraction from a model response. Models occasionally wrap
// JSON in fences or add a trailing sentence even when told not to; this
// helper is the single place we forgive that.

export function extractJsonObject(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) return fence[1].trim()
  const obj = text.match(/\{[\s\S]*\}/)
  if (obj) return obj[0]
  throw new Error('no JSON object found in model output')
}

export function parseJsonObject<T = unknown>(text: string): T {
  return JSON.parse(extractJsonObject(text)) as T
}
