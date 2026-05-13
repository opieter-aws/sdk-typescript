import { describe, expect, it, beforeEach } from 'vitest'
import { InMemoryKnowledgeStore } from '../in-memory-knowledge-store.js'

describe('InMemoryKnowledgeStore', () => {
  let store: InMemoryKnowledgeStore
  const namespace = 'user-123'

  beforeEach(() => {
    store = new InMemoryKnowledgeStore()
  })

  describe('store', () => {
    it('should store an entry and return an id', async () => {
      const id = await store.store(namespace, 'The user prefers dark mode')
      expect(id).toBeDefined()
      expect(typeof id).toBe('string')
    })

    it('should store metadata alongside content', async () => {
      await store.store(namespace, 'User lives in Seattle', { category: 'personal', source: 'conversation' })
      const results = await store.search(namespace, 'Seattle')
      expect(results[0]!.metadata).toStrictEqual({ category: 'personal', source: 'conversation' })
    })

    it('should store to separate namespaces independently', async () => {
      await store.store('user-1', 'fact for user 1')
      await store.store('user-2', 'fact for user 2')

      const r1 = await store.search('user-1', 'fact')
      const r2 = await store.search('user-2', 'fact')
      expect(r1).toHaveLength(1)
      expect(r2).toHaveLength(1)
    })
  })

  describe('search', () => {
    it('should return matching results with scores', async () => {
      await store.store(namespace, 'the user prefers dark mode for their IDE')
      await store.store(namespace, 'the user works in a software company')

      const results = await store.search(namespace, 'dark mode')
      expect(results).toHaveLength(1)
      expect(results[0]!.score).toBe(1)
      expect(results[0]!.content).toContain('dark mode')
    })

    it('should populate namespace on results', async () => {
      await store.store(namespace, 'some fact')
      const results = await store.search(namespace, 'fact')
      expect(results[0]!.namespace).toBe(namespace)
    })

    it('should only return entries containing the query substring', async () => {
      await store.store(namespace, 'cats are furry animals that purr')
      await store.store(namespace, 'dogs bark and like to play fetch')

      const results = await store.search(namespace, 'cats')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toContain('cats')
    })

    it('should return empty results for empty query', async () => {
      await store.store(namespace, 'some content')
      const results = await store.search(namespace, '')
      expect(results).toHaveLength(0)
    })

    it('should return empty results for non-matching query', async () => {
      await store.store(namespace, 'hello world')
      const results = await store.search(namespace, 'xyz123nonexistent')
      expect(results).toHaveLength(0)
    })

    it('should respect limit', async () => {
      for (let i = 0; i < 10; i++) {
        await store.store(namespace, `fact about programming ${i}`)
      }

      const results = await store.search(namespace, 'programming', 3)
      expect(results).toHaveLength(3)
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
