import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MemoryManager } from '../memory-manager.js'
import { InMemoryKnowledgeStore } from '../in-memory-knowledge-store.js'
import { Agent } from '../../agent/agent.js'
import type { Extractor } from '../extractor/types.js'
import type { MessageData } from '../../types/messages.js'

vi.mock('../../models/bedrock.js', () => ({
  BedrockModel: class MockModel {
    stateful = false
    countTokens = vi.fn().mockResolvedValue(10)
    stream = vi.fn()
  },
}))

function createMockExtractor(facts: Array<{ content: string }>): Extractor {
  return {
    extract: vi.fn().mockResolvedValue(facts),
  }
}

describe('MemoryManager', () => {
  let store1: InMemoryKnowledgeStore
  let store2: InMemoryKnowledgeStore
  const namespace1 = 'ns-1'
  const namespace2 = 'ns-2'

  beforeEach(() => {
    store1 = new InMemoryKnowledgeStore()
    store2 = new InMemoryKnowledgeStore()
  })

  describe('search', () => {
    it('should search across multiple stores and merge results', async () => {
      await store1.store(namespace1, 'user prefers dark mode')
      await store2.store(namespace2, 'user prefers light theme for reading')

      const manager = new MemoryManager({
        stores: [
          { store: store1, namespace: namespace1 },
          { store: store2, namespace: namespace2 },
        ],
      })

      const results = await manager.search('prefers')
      expect(results).toHaveLength(2)
    })

    it('should deduplicate results by ID', async () => {
      const manager = new MemoryManager({
        stores: [
          { store: store1, namespace: namespace1 },
          { store: store1, namespace: namespace1 },
        ],
      })

      await store1.store(namespace1, 'some fact about testing')
      const results = await manager.search('testing')
      expect(results).toHaveLength(1)
    })

    it('should respect per-store limit', async () => {
      for (let i = 0; i < 10; i++) {
        await store1.store(namespace1, `programming fact ${i}`)
      }

      const manager = new MemoryManager({
        stores: [{ store: store1, namespace: namespace1, limit: 3 }],
      })

      const results = await manager.search('programming')
      expect(results).toHaveLength(3)
    })
  })

  describe('store', () => {
    it('should write to first store with tool trigger', async () => {
      const manager = new MemoryManager({
        stores: [
          { store: store1, namespace: namespace1, ingestion: { trigger: 'tool' } },
          { store: store2, namespace: namespace2, ingestion: { trigger: 'tool' } },
        ],
      })

      await manager.store('a new fact about cats')
      const results = await store1.search(namespace1, 'cats')
      expect(results).toHaveLength(1)
    })

    it('should skip stores without tool trigger', async () => {
      const manager = new MemoryManager({
        stores: [
          { store: store1, namespace: namespace1 },
          { store: store2, namespace: namespace2, ingestion: { trigger: 'tool' } },
        ],
      })

      await manager.store('fact goes to store2 about dogs')
      const r1 = await store1.search(namespace1, 'dogs')
      expect(r1).toHaveLength(0)
      const r2 = await store2.search(namespace2, 'dogs')
      expect(r2).toHaveLength(1)
    })

    it('should throw if no store has tool trigger', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, namespace: 'ro' }],
      })

      await expect(manager.store('test')).rejects.toThrow('no store configured with "tool" ingestion trigger')
    })

    it('should pass metadata to store with provenance tag', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, namespace: namespace1, ingestion: { trigger: 'tool' } }],
      })

      await manager.store('fact with meta about cats', { category: 'test', source: 'manual' })
      const results = await store1.search(namespace1, 'cats')
      expect(results[0]!.metadata).toStrictEqual({ category: 'test', source: 'manual', _source: 'tool' })
    })

    it('should tag stored facts with _source "tool"', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, namespace: namespace1, ingestion: { trigger: 'tool' } }],
      })

      await manager.store('fact without user metadata about dogs')
      const results = await store1.search(namespace1, 'dogs')
      expect(results[0]!.metadata).toStrictEqual({ _source: 'tool' })
    })

    it('should use default namespace when not specified', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
      })

      await manager.store('fact about default namespace')
      const results = await store1.search('default', 'default namespace')
      expect(results).toHaveLength(1)
    })

    it('should work with combined triggers including tool', async () => {
      const extractor = createMockExtractor([{ content: 'extracted fact' }])
      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            namespace: namespace1,
            ingestion: { trigger: ['tool', 'perTurn'], extractor },
          },
        ],
      })

      await manager.store('explicit fact about cats')
      const results = await store1.search(namespace1, 'cats')
      expect(results).toHaveLength(1)
      expect(results[0]!.metadata?._source).toBe('tool')
    })
  })

  describe('onTurnComplete', () => {
    const messages: MessageData[] = [
      { role: 'user', content: [{ text: 'I like cats' }] },
      { role: 'assistant', content: [{ text: 'Noted!' }] },
    ]

    it('should run extractor for perTurn stores', async () => {
      const extractor = createMockExtractor([{ content: 'User likes cats' }])

      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            namespace: namespace1,
            ingestion: { trigger: 'perTurn', extractor },
          },
        ],
      })

      await manager.onTurnComplete(messages)

      expect(extractor.extract).toHaveBeenCalledWith(messages)
      const results = await store1.search(namespace1, 'cats')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toBe('User likes cats')
    })

    it('should tag extracted facts with _source "extraction" and _extractedAt', async () => {
      const extractor = createMockExtractor([{ content: 'User likes dogs' }])

      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            namespace: namespace1,
            ingestion: { trigger: 'perTurn', extractor },
          },
        ],
      })

      await manager.onTurnComplete(messages)

      const results = await store1.search(namespace1, 'dogs')
      expect(results[0]!.metadata?._source).toBe('extraction')
      expect(results[0]!.metadata?._extractedAt).toBeDefined()
      expect(new Date(results[0]!.metadata!._extractedAt as string).getTime()).not.toBeNaN()
    })

    it('should run scheduled extractor on correct interval', async () => {
      const extractor = createMockExtractor([{ content: 'extracted' }])

      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            namespace: namespace1,
            ingestion: { trigger: 'scheduled', extractor, interval: 3 },
          },
        ],
      })

      await manager.onTurnComplete(messages)
      await manager.onTurnComplete(messages)
      expect(extractor.extract).not.toHaveBeenCalled()

      await manager.onTurnComplete(messages)
      expect(extractor.extract).toHaveBeenCalledOnce()
    })

    it('should not run extractor for stores without ingestion config', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, namespace: namespace1 }],
      })

      await manager.onTurnComplete(messages)
      const results = await store1.search(namespace1, 'cats')
      expect(results).toHaveLength(0)
    })

    it('should not throw on extractor failure', async () => {
      const extractor: Extractor = {
        extract: vi.fn().mockRejectedValue(new Error('extraction failed')),
      }

      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            namespace: namespace1,
            ingestion: { trigger: 'perTurn', extractor },
          },
        ],
      })

      await expect(manager.onTurnComplete(messages)).resolves.toBeUndefined()
    })

    it('should store raw message text when no extractor is configured', async () => {
      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            namespace: namespace1,
            ingestion: { trigger: 'perTurn' },
          },
        ],
      })

      await manager.onTurnComplete(messages)

      const results = await store1.search(namespace1, 'cats')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toBe('user: I like cats\nassistant: Noted!')
    })

    it('should not store empty content when messages have no text', async () => {
      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            namespace: namespace1,
            ingestion: { trigger: 'perTurn' },
          },
        ],
      })

      const emptyMessages: MessageData[] = [
        { role: 'user', content: [{ toolUse: { toolUseId: '1', name: 'test', input: {} } }] },
      ]

      await manager.onTurnComplete(emptyMessages)

      const results = await store1.search(namespace1, '')
      expect(results).toHaveLength(0)
    })

    it('should tag raw ingestion with extraction metadata', async () => {
      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            namespace: namespace1,
            ingestion: { trigger: 'perTurn' },
          },
        ],
      })

      await manager.onTurnComplete(messages)

      const results = await store1.search(namespace1, 'cats')
      expect(results[0]!.metadata?._source).toBe('extraction')
      expect(results[0]!.metadata?._extractedAt).toBeDefined()
    })
  })

  describe('onEviction', () => {
    const messages: MessageData[] = [{ role: 'user', content: [{ text: 'old conversation about cats' }] }]

    it('should run extractor for onEviction stores', async () => {
      const extractor = createMockExtractor([{ content: 'evicted fact about cats' }])

      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            namespace: namespace1,
            ingestion: { trigger: 'onEviction', extractor },
          },
        ],
      })

      await manager.onEviction(messages)

      expect(extractor.extract).toHaveBeenCalledWith(messages)
      const results = await store1.search(namespace1, 'cats')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toBe('evicted fact about cats')
    })

    it('should not run perTurn extractor on eviction', async () => {
      const extractor = createMockExtractor([{ content: 'fact' }])

      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            namespace: namespace1,
            ingestion: { trigger: 'perTurn', extractor },
          },
        ],
      })

      await manager.onEviction(messages)
      expect(extractor.extract).not.toHaveBeenCalled()
    })

    it('should store raw message text on eviction when no extractor is configured', async () => {
      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            namespace: namespace1,
            ingestion: { trigger: 'onEviction' },
          },
        ],
      })

      await manager.onEviction(messages)

      const results = await store1.search(namespace1, 'cats')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toBe('user: old conversation about cats')
    })
  })

  describe('getTools', () => {
    it('should return search_memory and store_memory when store has tool trigger', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, namespace: namespace1, ingestion: { trigger: 'tool' } }],
      })

      const tools = manager.getTools()
      const names = tools.map((t) => t.name)
      expect(names).toContain('search_memory')
      expect(names).toContain('store_memory')
    })

    it('should return store_memory when tool trigger is in array', () => {
      const extractor = createMockExtractor([])
      const manager = new MemoryManager({
        stores: [{ store: store1, namespace: namespace1, ingestion: { trigger: ['tool', 'perTurn'], extractor } }],
      })

      const tools = manager.getTools()
      const names = tools.map((t) => t.name)
      expect(names).toContain('search_memory')
      expect(names).toContain('store_memory')
    })

    it('should return only search_memory when no store has tool trigger', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, namespace: namespace1 }],
      })

      const tools = manager.getTools()
      const names = tools.map((t) => t.name)
      expect(names).toContain('search_memory')
      expect(names).not.toContain('store_memory')
    })

    it('should return only search_memory when triggers are non-tool only', () => {
      const extractor = createMockExtractor([])
      const manager = new MemoryManager({
        stores: [{ store: store1, namespace: namespace1, ingestion: { trigger: 'perTurn', extractor } }],
      })

      const tools = manager.getTools()
      const names = tools.map((t) => t.name)
      expect(names).toContain('search_memory')
      expect(names).not.toContain('store_memory')
    })

    it('should return empty when tools disabled', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, namespace: namespace1, ingestion: { trigger: 'tool' } }],
        tools: false,
      })

      expect(manager.getTools()).toHaveLength(0)
    })
  })

  describe('plugin interface', () => {
    it('should have the correct name', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, namespace: namespace1 }],
      })
      expect(manager.name).toBe('strands:memory-manager')
    })

    it('should register AfterInvocationEvent hook on initAgent', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, namespace: namespace1 }],
      })

      const addHook = vi.fn()
      const mockAgent = { addHook, messages: [] } as unknown as Parameters<typeof manager.initAgent>[0]

      manager.initAgent(mockAgent)
      expect(addHook).toHaveBeenCalledOnce()
    })
  })

  describe('Agent config integration', () => {
    it('should accept memoryManager as a top-level config parameter', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, namespace: namespace1, ingestion: { trigger: 'tool' } }],
      })

      const agent = new Agent({ memoryManager: manager })
      expect(agent.memoryManager).toBe(manager)
    })

    it('should expose memoryManager as undefined when not configured', () => {
      const agent = new Agent({})
      expect(agent.memoryManager).toBeUndefined()
    })

    it('should register memory tools when passed via config', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, namespace: namespace1, ingestion: { trigger: 'tool' } }],
      })

      const agent = new Agent({ memoryManager: manager })
      await agent.initialize()

      const toolNames = agent.tools.map((t) => t.name)
      expect(toolNames).toContain('search_memory')
      expect(toolNames).toContain('store_memory')
    })

    it('should still work when passed via plugins array (backward compat)', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, namespace: namespace1, ingestion: { trigger: 'tool' } }],
      })

      const agent = new Agent({ plugins: [manager] })
      await agent.initialize()

      const toolNames = agent.tools.map((t) => t.name)
      expect(toolNames).toContain('search_memory')
      expect(toolNames).toContain('store_memory')
    })
  })
})
