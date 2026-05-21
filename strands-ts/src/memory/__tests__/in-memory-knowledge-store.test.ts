import { describe, expect, it, beforeEach } from 'vitest'
import { InMemoryKnowledgeStore } from '../in-memory-knowledge-store.js'

describe('InMemoryKnowledgeStore', () => {
  let store: InMemoryKnowledgeStore

  beforeEach(() => {
    store = new InMemoryKnowledgeStore()
  })

  describe('add', () => {
    it('should store an entry', async () => {
      await store.add('The user prefers dark mode')
      const results = await store.search('dark mode')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toContain('dark mode')
    })

    it('should store metadata alongside content', async () => {
      await store.add('User lives in Seattle', { category: 'personal', source: 'conversation' })
      const results = await store.search('Seattle')
      expect(results[0]!.metadata).toMatchObject({ category: 'personal', source: 'conversation' })
    })

    it('should isolate entries across separate instances', async () => {
      const store2 = new InMemoryKnowledgeStore()
      await store.add('fact for store 1')
      await store2.add('fact for store 2')

      const r1 = await store.search('fact')
      const r2 = await store2.search('fact')
      expect(r1).toHaveLength(1)
      expect(r1[0]!.content).toContain('store 1')
      expect(r2).toHaveLength(1)
      expect(r2[0]!.content).toContain('store 2')
    })
  })

  describe('search', () => {
    it('should return matching results with score in metadata', async () => {
      await store.add('the user prefers dark mode for their IDE')
      await store.add('the user works in a software company')

      const results = await store.search('dark mode')
      expect(results).toHaveLength(1)
      expect(results[0]!.metadata?.score).toBe(1)
      expect(results[0]!.content).toContain('dark mode')
    })

    it('should only return entries containing the query substring', async () => {
      await store.add('cats are furry animals that purr')
      await store.add('dogs bark and like to play fetch')

      const results = await store.search('cats')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toContain('cats')
    })

    it('should return empty results for empty query', async () => {
      await store.add('some content')
      const results = await store.search('')
      expect(results).toHaveLength(0)
    })

    it('should return empty results for non-matching query', async () => {
      await store.add('hello world')
      const results = await store.search('xyz123nonexistent')
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
