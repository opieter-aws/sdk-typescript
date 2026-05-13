import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { FileKnowledgeStore } from '../file-knowledge-store.js'

describe('FileKnowledgeStore', () => {
  let store: FileKnowledgeStore
  let tmpDir: string
  const namespace = 'test-ns'

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fks-test-'))
    store = new FileKnowledgeStore({ baseDir: tmpDir })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('store', () => {
    it('should store an entry and return an id', async () => {
      const id = await store.store(namespace, 'The user prefers dark mode')
      expect(id).toBeDefined()
      expect(typeof id).toBe('string')
    })

    it('should persist entry to disk', async () => {
      const id = await store.store(namespace, 'persisted fact')
      const filePath = path.join(tmpDir, namespace, 'entries', `${id}.json`)
      const raw = await fs.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      expect(parsed.content).toBe('persisted fact')
      expect(parsed.id).toBe(id)
    })

    it('should store metadata alongside content', async () => {
      await store.store(namespace, 'User lives in Seattle', { category: 'personal' })
      const results = await store.search(namespace, 'Seattle')
      expect(results[0]!.metadata).toStrictEqual({ category: 'personal' })
    })

    it('should not leave .tmp files after successful store', async () => {
      await store.store(namespace, 'atomic write test')
      const dir = path.join(tmpDir, namespace, 'entries')
      const files = await fs.readdir(dir)
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'))
      expect(tmpFiles).toHaveLength(0)
    })

    it('should ignore orphaned .tmp files during search', async () => {
      const dir = path.join(tmpDir, namespace, 'entries')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'orphan.json.tmp'), JSON.stringify({ id: 'x', content: 'orphaned data' }))

      const results = await store.search(namespace, 'orphaned')
      expect(results).toHaveLength(0)
    })
  })

  describe('search', () => {
    it('should return matching results', async () => {
      await store.store(namespace, 'the user prefers dark mode for their IDE')
      await store.store(namespace, 'the user works in a software company')

      const results = await store.search(namespace, 'dark mode')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toContain('dark mode')
    })

    it('should return empty results for empty query', async () => {
      await store.store(namespace, 'some content')
      const results = await store.search(namespace, '')
      expect(results).toHaveLength(0)
    })

    it('should respect limit', async () => {
      for (let i = 0; i < 10; i++) {
        await store.store(namespace, `fact about programming ${i}`)
      }

      const results = await store.search(namespace, 'programming', 3)
      expect(results).toHaveLength(3)
    })

    it('should populate namespace on results', async () => {
      await store.store(namespace, 'some fact')
      const results = await store.search(namespace, 'fact')
      expect(results[0]!.namespace).toBe(namespace)
    })
  })

  describe('delete', () => {
    it('should delete an entry', async () => {
      const id = await store.store(namespace, 'to delete with cats')
      await store.store(namespace, 'to keep with cats')

      await store.delete(namespace, id)

      const results = await store.search(namespace, 'cats')
      expect(results).toHaveLength(1)
      expect(results[0]!.id).not.toBe(id)
    })

    it('should throw for non-existent id', async () => {
      await expect(store.delete(namespace, 'non-existent')).rejects.toThrow('Entry not found')
    })
  })
})
