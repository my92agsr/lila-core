import { describe, it, expect } from 'vitest'
import { formatForTelegram, splitMessage } from './bot.js'

describe('formatForTelegram', () => {
  it('converts bold markdown to HTML', () => {
    expect(formatForTelegram('**hello**')).toBe('<b>hello</b>')
  })

  it('converts italic markdown to HTML', () => {
    expect(formatForTelegram('*hello*')).toBe('<i>hello</i>')
  })

  it('converts inline code', () => {
    expect(formatForTelegram('use `npm install`')).toBe('use <code>npm install</code>')
  })

  it('converts code blocks', () => {
    const input = '```js\nconsole.log("hi")\n```'
    const result = formatForTelegram(input)
    expect(result).toContain('<pre>')
    expect(result).toContain('console.log')
  })

  it('converts headings to bold', () => {
    expect(formatForTelegram('# Title')).toBe('<b>Title</b>')
    expect(formatForTelegram('## Subtitle')).toBe('<b>Subtitle</b>')
  })

  it('converts links', () => {
    expect(formatForTelegram('[Google](https://google.com)')).toBe('<a href="https://google.com">Google</a>')
  })

  it('converts strikethrough', () => {
    expect(formatForTelegram('~~deleted~~')).toBe('<s>deleted</s>')
  })

  it('converts checkboxes', () => {
    expect(formatForTelegram('- [ ] todo')).toContain('☐')
    expect(formatForTelegram('- [x] done')).toContain('☑')
  })

  it('escapes HTML entities in text', () => {
    const result = formatForTelegram('a < b & c > d')
    expect(result).toContain('&lt;')
    expect(result).toContain('&amp;')
    expect(result).toContain('&gt;')
  })

  it('does not escape inside code blocks', () => {
    const input = '```\nif (a < b) {}\n```'
    const result = formatForTelegram(input)
    expect(result).toContain('&lt;')  // should be escaped inside pre too
  })
})

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    expect(splitMessage('hello')).toEqual(['hello'])
  })

  it('splits long messages on newlines', () => {
    const long = Array(100).fill('This is a line of text that takes up space.').join('\n')
    const chunks = splitMessage(long, 200)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200)
    }
  })

  it('joins back to original content', () => {
    const original = 'line1\nline2\nline3\nline4\nline5'
    const chunks = splitMessage(original, 15)
    const rejoined = chunks.join('\n')
    // All original content should be present
    expect(rejoined).toContain('line1')
    expect(rejoined).toContain('line5')
  })
})
