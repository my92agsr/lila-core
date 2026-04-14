import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, existsSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// Ensure store dir exists for tests
const __dirname = dirname(fileURLToPath(import.meta.url))
const storeDir = join(__dirname, '..', 'store')
if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true })

import {
  initDatabase,
  getSession,
  setSession,
  clearSession,
  insertMemory,
  searchMemories,
  getRecentMemories,
  decayMemories,
  getMemoriesForChat,
  createTask,
  getAllTasks,
  deleteTask,
  getDueTasks,
  getDb,
} from './db.js'

describe('database', () => {
  beforeAll(() => {
    initDatabase()
  })

  describe('sessions', () => {
    it('stores and retrieves sessions', () => {
      setSession('test-chat', 'session-abc')
      expect(getSession('test-chat')).toBe('session-abc')
    })

    it('updates existing sessions', () => {
      setSession('test-chat', 'session-def')
      expect(getSession('test-chat')).toBe('session-def')
    })

    it('clears sessions', () => {
      clearSession('test-chat')
      expect(getSession('test-chat')).toBeUndefined()
    })

    it('returns undefined for missing sessions', () => {
      expect(getSession('nonexistent')).toBeUndefined()
    })
  })

  describe('memories', () => {
    it('inserts and retrieves memories', () => {
      insertMemory('mem-chat', 'I like TypeScript and Node.js', 'semantic')
      const memories = getMemoriesForChat('mem-chat')
      expect(memories.length).toBeGreaterThan(0)
      expect(memories[0].content).toContain('TypeScript')
    })

    it('searches via FTS', () => {
      insertMemory('mem-chat', 'My favorite color is blue', 'semantic')
      const results = searchMemories('favorite color', 'mem-chat')
      expect(results.length).toBeGreaterThan(0)
    })

    it('gets recent memories', () => {
      const recent = getRecentMemories('mem-chat', 5)
      expect(recent.length).toBeGreaterThan(0)
    })
  })

  describe('scheduled tasks', () => {
    it('creates and lists tasks', () => {
      createTask('test-t1', 'chat-1', 'test prompt', '0 9 * * *', Math.floor(Date.now() / 1000) + 3600)
      const tasks = getAllTasks()
      expect(tasks.some(t => t.id === 'test-t1')).toBe(true)
    })

    it('deletes tasks', () => {
      expect(deleteTask('test-t1')).toBe(true)
      expect(deleteTask('test-t1')).toBe(false)
    })

    it('gets due tasks', () => {
      createTask('test-t2', 'chat-1', 'due task', '* * * * *', Math.floor(Date.now() / 1000) - 60)
      const due = getDueTasks()
      expect(due.some(t => t.id === 'test-t2')).toBe(true)
      deleteTask('test-t2')
    })
  })
})
