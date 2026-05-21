import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { FileKnowledgeStore } from '../file-knowledge-store.js'

describe('FileKnowledgeStore', () => {
  let store: FileKnowledgeStore
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fks-test-'))
    store = new FileKnowledgeStore({ baseDir: tmpDir })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('add', () => {
    it('should store an entry', async () => {
      await store.add('The user prefers dark mode')
      const results = await store.search('dark mode')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toContain('dark mode')
    })

    it('should persist entry to disk', async () => {
      await store.add('persisted fact')
      const dir = path.join(tmpDir, 'entries')
      const files = await fs.readdir(dir)
      const jsonFiles = files.filter((f) => f.endsWith('.json'))
      expect(jsonFiles).toHaveLength(1)
      const raw = await fs.readFile(path.join(dir, jsonFiles[0]!), 'utf-8')
      const parsed = JSON.parse(raw)
      expect(parsed.content).toBe('persisted fact')
    })

    it('should store metadata alongside content', async () => {
      await store.add('User lives in Seattle', { category: 'personal' })
      const results = await store.search('Seattle')
      expect(results[0]!.metadata).toMatchObject({ category: 'personal' })
    })

    it('should not leave .tmp files after successful store', async () => {
      await store.add('atomic write test')
      const dir = path.join(tmpDir, 'entries')
      const files = await fs.readdir(dir)
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'))
      expect(tmpFiles).toHaveLength(0)
    })

    it('should ignore orphaned .tmp files during search', async () => {
      const dir = path.join(tmpDir, 'entries')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'orphan.json.tmp'), JSON.stringify({ id: 'x', content: 'orphaned data' }))

      const results = await store.search('orphaned')
      expect(results).toHaveLength(0)
    })
  })

  describe('search', () => {
    it('should return matching results', async () => {
      await store.add('the user prefers dark mode for their IDE')
      await store.add('the user works in a software company')

      const results = await store.search('dark mode')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toContain('dark mode')
    })

    it('should match entries containing any query token', async () => {
      await store.add('Alex prefers dark mode')
      await store.add('Alex works at a startup in Austin')
      await store.add('unrelated entry about weather')

      const results = await store.search('Alex dark Austin')
      expect(results).toHaveLength(2)
    })

    it('should rank entries by number of matching tokens', async () => {
      await store.add('Alex prefers dark mode')
      await store.add('Alex works in Austin at a dark office')

      const results = await store.search('Alex dark Austin')
      // Second entry has 3/3 tokens, first has 2/3
      expect(results[0]!.content).toContain('Austin')
      expect(results[0]!.metadata?.score as number).toBeGreaterThan(results[1]!.metadata?.score as number)
    })

    it('should return score as fraction of matched tokens in metadata', async () => {
      await store.add('Alex prefers dark mode')

      const results = await store.search('Alex dark Austin')
      // Matches "Alex" and "dark" (2 of 3 tokens)
      expect(results[0]!.metadata?.score).toBeCloseTo(2 / 3)
    })

    it('should return empty results for empty query', async () => {
      await store.add('some content')
      const results = await store.search('')
      expect(results).toHaveLength(0)
    })

    it('should return empty results for whitespace-only query', async () => {
      await store.add('some content')
      const results = await store.search('   ')
      expect(results).toHaveLength(0)
    })

    it('should respect limit in options', async () => {
      for (let i = 0; i < 10; i++) {
        await store.add(`fact about programming ${i}`)
      }

      const results = await store.search('programming', { limit: 3 })
      expect(results).toHaveLength(3)
    })
  })

  describe('delete', () => {
    it('should delete an entry', async () => {
      await store.add('to delete with cats')
      await store.add('to keep with cats')

      const before = await store.search('cats')
      expect(before).toHaveLength(2)
      const idToDelete = before[0]!.id

      await store.delete(idToDelete)

      const after = await store.search('cats')
      expect(after).toHaveLength(1)
      expect(after[0]!.id).not.toBe(idToDelete)
    })

    it('should throw for non-existent id', async () => {
      await expect(store.delete('non-existent')).rejects.toThrow('Entry not found')
    })
  })
})
