import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '..', '.env')

// We need to dynamically import to avoid caching
async function freshImport() {
  const mod = await import(`./env.js?t=${Date.now()}`)
  return mod.readEnvFile as (keys?: string[]) => Record<string, string>
}

describe('readEnvFile', () => {
  let hadEnv = false
  let origContent = ''

  beforeEach(() => {
    if (existsSync(envPath)) {
      hadEnv = true
      origContent = require('fs').readFileSync(envPath, 'utf-8')
    }
  })

  afterEach(() => {
    if (hadEnv) {
      writeFileSync(envPath, origContent)
    } else {
      try { unlinkSync(envPath) } catch {}
    }
  })

  it('parses KEY=VALUE pairs', async () => {
    writeFileSync(envPath, 'FOO=bar\nBAZ=qux\n')
    const { readEnvFile } = await import('./env.js')
    const result = readEnvFile()
    expect(result.FOO).toBe('bar')
    expect(result.BAZ).toBe('qux')
  })

  it('strips quotes from values', async () => {
    writeFileSync(envPath, 'A="hello world"\nB=\'single\'\n')
    const { readEnvFile } = await import('./env.js')
    const result = readEnvFile()
    expect(result.A).toBe('hello world')
    expect(result.B).toBe('single')
  })

  it('skips comments and blank lines', async () => {
    writeFileSync(envPath, '# comment\n\nKEY=val\n')
    const { readEnvFile } = await import('./env.js')
    const result = readEnvFile()
    expect(Object.keys(result)).toHaveLength(1)
    expect(result.KEY).toBe('val')
  })

  it('filters by requested keys', async () => {
    writeFileSync(envPath, 'A=1\nB=2\nC=3\n')
    const { readEnvFile } = await import('./env.js')
    const result = readEnvFile(['A', 'C'])
    expect(result).toEqual({ A: '1', C: '3' })
  })
})
