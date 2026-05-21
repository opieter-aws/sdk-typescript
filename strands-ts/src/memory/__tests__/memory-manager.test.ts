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

  beforeEach(() => {
    store1 = new InMemoryKnowledgeStore()
    store2 = new InMemoryKnowledgeStore()
  })

  describe('search', () => {
    it('should search across multiple stores and merge results', async () => {
      await store1.add('user prefers dark mode')
      await store2.add('user prefers light theme for reading')

      const manager = new MemoryManager({
        stores: [{ store: store1 }, { store: store2 }],
      })

      const results = await manager.search('prefers')
      expect(results).toHaveLength(2)
    })

    it('should deduplicate results by ID', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1 }, { store: store1 }],
      })

      await store1.add('some fact about testing')
      const results = await manager.search('testing')
      expect(results).toHaveLength(1)
    })

    it('should respect per-store limit', async () => {
      for (let i = 0; i < 10; i++) {
        await store1.add(`programming fact ${i}`)
      }

      const manager = new MemoryManager({
        stores: [{ store: store1, limit: 3 }],
      })

      const results = await manager.search('programming')
      expect(results).toHaveLength(3)
    })
  })

  describe('store', () => {
    it('should write to ALL stores with tool trigger (fan-out)', async () => {
      const manager = new MemoryManager({
        stores: [
          { store: store1, ingestion: { trigger: 'tool' } },
          { store: store2, ingestion: { trigger: 'tool' } },
        ],
      })

      await manager.store('a new fact about cats')
      const results1 = await store1.search('cats')
      const results2 = await store2.search('cats')
      expect(results1).toHaveLength(1)
      expect(results2).toHaveLength(1)
    })

    it('should skip stores without tool trigger', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1 }, { store: store2, ingestion: { trigger: 'tool' } }],
      })

      await manager.store('fact goes to store2 about dogs')
      const r1 = await store1.search('dogs')
      expect(r1).toHaveLength(0)
      const r2 = await store2.search('dogs')
      expect(r2).toHaveLength(1)
    })

    it('should throw if no store has tool trigger', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1 }],
      })

      await expect(manager.store('test')).rejects.toThrow('no store configured with "tool" ingestion trigger')
    })

    it('should pass metadata to store with provenance tag', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
      })

      await manager.store('fact with meta about cats', { category: 'test', source: 'manual' })
      const results = await store1.search('cats')
      expect(results[0]!.metadata).toMatchObject({ category: 'test', source: 'manual', strands_source: 'tool' })
    })

    it('should tag stored facts with strands_source "tool"', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
      })

      await manager.store('fact without user metadata about dogs')
      const results = await store1.search('dogs')
      expect(results[0]!.metadata).toMatchObject({ strands_source: 'tool' })
    })

    it('should work with combined triggers including tool', async () => {
      const extractor = createMockExtractor([{ content: 'extracted fact' }])
      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            ingestion: { trigger: ['tool', 'perTurn'], extractor },
          },
        ],
      })

      await manager.store('explicit fact about cats')
      const results = await store1.search('cats')
      expect(results).toHaveLength(1)
      expect(results[0]!.metadata?.strands_source).toBe('tool')
    })
  })

  describe('enqueue (non-blocking store)', () => {
    it('should not throw when enqueuing', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
      })

      expect(() => manager.enqueue('a fact about cats')).not.toThrow()
    })

    it('should persist entry after flush', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
      })

      manager.enqueue('cats are great')
      await manager.flush()

      const results = await store1.search('cats')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toBe('cats are great')
    })

    it('should serialize multiple enqueued writes', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
      })

      manager.enqueue('fact one about dogs')
      manager.enqueue('fact two about dogs')
      manager.enqueue('fact three about dogs')
      await manager.flush()

      const results = await store1.search('dogs')
      expect(results).toHaveLength(3)
    })

    it('should tag entries with strands_source "tool"', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
      })

      manager.enqueue('fact about cats')
      await manager.flush()

      const results = await store1.search('cats')
      expect(results[0]!.metadata?.strands_source).toBe('tool')
    })

    it('should include user metadata', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
      })

      manager.enqueue('fact about cats', { category: 'animals' })
      await manager.flush()

      const results = await store1.search('cats')
      expect(results[0]!.metadata).toMatchObject({ category: 'animals', strands_source: 'tool' })
    })

    it('should not break subsequent writes when one fails', async () => {
      const failingStore = {
        add: vi
          .fn()
          .mockRejectedValueOnce(new Error('disk full'))
          .mockImplementation((content: string, metadata?: Record<string, unknown>) => store1.add(content, metadata)),
        search: store1.search.bind(store1),
        delete: store1.delete.bind(store1),
      }

      const manager = new MemoryManager({
        stores: [{ store: failingStore, ingestion: { trigger: 'tool' } }],
      })

      manager.enqueue('will fail')
      manager.enqueue('will succeed about cats')
      await manager.flush()

      const results = await store1.search('cats')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toBe('will succeed about cats')
    })

    it('should throw if no store has tool trigger', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1 }],
      })

      expect(() => manager.enqueue('test')).toThrow('no store configured with "tool" ingestion trigger')
    })

    it('flush should resolve immediately when nothing is enqueued', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
      })

      await expect(manager.flush()).resolves.toBeUndefined()
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
            ingestion: { trigger: 'perTurn', extractor },
          },
        ],
      })

      await manager.onTurnComplete(messages)

      expect(extractor.extract).toHaveBeenCalledWith(messages)
      const results = await store1.search('cats')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toBe('User likes cats')
    })

    it('should tag extracted facts with strands_source "extraction" and strands_extractedAt', async () => {
      const extractor = createMockExtractor([{ content: 'User likes dogs' }])

      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            ingestion: { trigger: 'perTurn', extractor },
          },
        ],
      })

      await manager.onTurnComplete(messages)

      const results = await store1.search('dogs')
      expect(results[0]!.metadata?.strands_source).toBe('extraction')
      expect(results[0]!.metadata?.strands_extractedAt).toBeDefined()
      expect(new Date(results[0]!.metadata!.strands_extractedAt as string).getTime()).not.toBeNaN()
    })

    it('should run scheduled extractor on correct interval', async () => {
      const extractor = createMockExtractor([{ content: 'extracted' }])

      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
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
        stores: [{ store: store1 }],
      })

      await manager.onTurnComplete(messages)
      const results = await store1.search('cats')
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
            ingestion: { trigger: 'perTurn' },
          },
        ],
      })

      await manager.onTurnComplete(messages)

      const results = await store1.search('cats')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toBe('user: I like cats\nassistant: Noted!')
    })

    it('should not store empty content when messages have no text', async () => {
      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            ingestion: { trigger: 'perTurn' },
          },
        ],
      })

      const emptyMessages: MessageData[] = [
        { role: 'user', content: [{ toolUse: { toolUseId: '1', name: 'test', input: {} } }] },
      ]

      await manager.onTurnComplete(emptyMessages)

      const results = await store1.search('')
      expect(results).toHaveLength(0)
    })

    it('should tag raw ingestion with strands_source "raw"', async () => {
      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            ingestion: { trigger: 'perTurn' },
          },
        ],
      })

      await manager.onTurnComplete(messages)

      const results = await store1.search('cats')
      expect(results[0]!.metadata?.strands_source).toBe('raw')
      expect(results[0]!.metadata?.strands_extractedAt).toBeDefined()
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
            ingestion: { trigger: 'onEviction', extractor },
          },
        ],
      })

      await manager.onEviction(messages)

      expect(extractor.extract).toHaveBeenCalledWith(messages)
      const results = await store1.search('cats')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toBe('evicted fact about cats')
    })

    it('should not run perTurn extractor on eviction', async () => {
      const extractor = createMockExtractor([{ content: 'fact' }])

      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
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
            ingestion: { trigger: 'onEviction' },
          },
        ],
      })

      await manager.onEviction(messages)

      const results = await store1.search('cats')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toBe('user: old conversation about cats')
    })
  })

  describe('getTools', () => {
    it('should return search_memory and store_memory when store has tool trigger', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
      })

      const tools = manager.getTools()
      const names = tools.map((t) => t.name)
      expect(names).toContain('search_memory')
      expect(names).toContain('store_memory')
    })

    it('should return store_memory when tool trigger is in array', () => {
      const extractor = createMockExtractor([])
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: ['tool', 'perTurn'], extractor } }],
      })

      const tools = manager.getTools()
      const names = tools.map((t) => t.name)
      expect(names).toContain('search_memory')
      expect(names).toContain('store_memory')
    })

    it('should return only search_memory when no store has tool trigger', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1 }],
      })

      const tools = manager.getTools()
      const names = tools.map((t) => t.name)
      expect(names).toContain('search_memory')
      expect(names).not.toContain('store_memory')
    })

    it('should return only search_memory when triggers are non-tool only', () => {
      const extractor = createMockExtractor([])
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'perTurn', extractor } }],
      })

      const tools = manager.getTools()
      const names = tools.map((t) => t.name)
      expect(names).toContain('search_memory')
      expect(names).not.toContain('store_memory')
    })

    it('should return empty when tools disabled', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
        tools: false,
      })

      expect(manager.getTools()).toHaveLength(0)
    })
  })

  describe('plugin interface', () => {
    it('should have the correct name', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1 }],
      })
      expect(manager.name).toBe('strands:memory-manager')
    })

    it('should register AfterInvocationEvent hook on initAgent', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1 }],
      })

      const addHook = vi.fn()
      const mockAgent = { addHook, messages: [] } as unknown as Parameters<typeof manager.initAgent>[0]

      manager.initAgent(mockAgent)
      expect(addHook).toHaveBeenCalledOnce()
    })

    it('should register both BeforeInvocation and AfterInvocation hooks when injection is enabled', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
        injection: true,
      })

      const addHook = vi.fn()
      const mockAgent = { addHook, messages: [] } as unknown as Parameters<typeof manager.initAgent>[0]

      manager.initAgent(mockAgent)
      expect(addHook).toHaveBeenCalledTimes(2)
    })
  })

  describe('Agent config integration', () => {
    it('should accept memoryManager as a MemoryManager instance', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
      })

      const agent = new Agent({ memoryManager: manager })
      expect(agent.memoryManager).toBe(manager)
    })

    it('should accept memoryManager as a plain config object', () => {
      const agent = new Agent({
        memoryManager: {
          stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
        },
      })
      expect(agent.memoryManager).toBeInstanceOf(MemoryManager)
    })

    it('should expose memoryManager as undefined when not configured', () => {
      const agent = new Agent({})
      expect(agent.memoryManager).toBeUndefined()
    })

    it('should register memory tools when passed via config', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
      })

      const agent = new Agent({ memoryManager: manager })
      await agent.initialize()

      const toolNames = agent.tools.map((t) => t.name)
      expect(toolNames).toContain('search_memory')
      expect(toolNames).toContain('store_memory')
    })

    it('should still work when passed via plugins array (backward compat)', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
      })

      const agent = new Agent({ plugins: [manager] })
      await agent.initialize()

      const toolNames = agent.tools.map((t) => t.name)
      expect(toolNames).toContain('search_memory')
      expect(toolNames).toContain('store_memory')
    })
  })

  describe('interleave merge', () => {
    it('should interleave results by rank across stores', async () => {
      await store1.add('alpha first')
      await store1.add('alpha second')
      await store1.add('alpha third')
      await store2.add('beta first')
      await store2.add('beta second')

      const manager = new MemoryManager({
        stores: [{ store: store1 }, { store: store2 }],
      })

      const results = await manager.search('first second third')
      expect(results.length).toBe(5)
      // Round-robin: store1 rank 0, store2 rank 0, store1 rank 1, store2 rank 1, store1 rank 2
      expect(results[0]!.content).toContain('alpha')
      expect(results[1]!.content).toContain('beta')
    })

    it('should respect options.limit as result cap after merge', async () => {
      for (let i = 0; i < 5; i++) {
        await store1.add(`fact ${i} about programming`)
        await store2.add(`fact ${i} about coding`)
      }

      const manager = new MemoryManager({
        stores: [{ store: store1 }, { store: store2 }],
      })

      const results = await manager.search('programming coding fact', { limit: 3 })
      expect(results).toHaveLength(3)
    })

    it('should respect options.limit as global cap', async () => {
      for (let i = 0; i < 5; i++) {
        await store1.add(`fact ${i} about coding`)
      }

      const manager = new MemoryManager({
        stores: [{ store: store1 }],
      })

      const results = await manager.search('coding fact', { limit: 2 })
      expect(results).toHaveLength(2)
    })
  })

  describe('high-water marks', () => {
    it('should only pass new messages on subsequent onTurnComplete calls', async () => {
      const extractor = createMockExtractor([{ content: 'extracted' }])

      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            ingestion: { trigger: 'perTurn', extractor },
          },
        ],
      })

      const msgs1: MessageData[] = [{ role: 'user', content: [{ text: 'message one' }] }]
      await manager.onTurnComplete(msgs1)
      expect(extractor.extract).toHaveBeenCalledWith(msgs1)

      const msgs2: MessageData[] = [
        { role: 'user', content: [{ text: 'message one' }] },
        { role: 'assistant', content: [{ text: 'reply' }] },
        { role: 'user', content: [{ text: 'message two' }] },
      ]
      await manager.onTurnComplete(msgs2)
      // Should only pass messages after index 1 (the HWM from first call)
      expect(extractor.extract).toHaveBeenLastCalledWith([
        { role: 'assistant', content: [{ text: 'reply' }] },
        { role: 'user', content: [{ text: 'message two' }] },
      ])
    })

    it('should not ingest when no new messages since last HWM', async () => {
      const extractor = createMockExtractor([{ content: 'extracted' }])

      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            ingestion: { trigger: 'perTurn', extractor },
          },
        ],
      })

      const msgs: MessageData[] = [{ role: 'user', content: [{ text: 'hello' }] }]
      await manager.onTurnComplete(msgs)
      expect(extractor.extract).toHaveBeenCalledOnce()

      // Same messages, no new content
      await manager.onTurnComplete(msgs)
      expect(extractor.extract).toHaveBeenCalledOnce()
    })

    it('should adjust HWM down on eviction', async () => {
      const extractor = createMockExtractor([{ content: 'extracted' }])

      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            ingestion: { trigger: 'perTurn', extractor },
          },
        ],
      })

      const msgs: MessageData[] = [
        { role: 'user', content: [{ text: 'msg 1' }] },
        { role: 'assistant', content: [{ text: 'resp 1' }] },
        { role: 'user', content: [{ text: 'msg 2' }] },
        { role: 'assistant', content: [{ text: 'resp 2' }] },
      ]
      await manager.onTurnComplete(msgs)
      expect(extractor.extract).toHaveBeenCalledWith(msgs)

      // Evict first 2 messages
      const evicted: MessageData[] = [
        { role: 'user', content: [{ text: 'msg 1' }] },
        { role: 'assistant', content: [{ text: 'resp 1' }] },
      ]
      await manager.onEviction(evicted)

      // Now remaining messages (after eviction) are only the last 2
      // HWM was 4, evicted 2, so HWM is now 2
      const remaining: MessageData[] = [
        { role: 'user', content: [{ text: 'msg 2' }] },
        { role: 'assistant', content: [{ text: 'resp 2' }] },
        { role: 'user', content: [{ text: 'msg 3' }] },
      ]
      await manager.onTurnComplete(remaining)
      // Only msg 3 should be new (index 2 onward, HWM was adjusted to 2)
      expect(extractor.extract).toHaveBeenLastCalledWith([{ role: 'user', content: [{ text: 'msg 3' }] }])
    })
  })

  describe('injection', () => {
    it('should inject memory into system prompt on BeforeInvocationEvent', async () => {
      await store1.add('user prefers dark mode')

      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
        injection: true,
      })

      const mockAgent = {
        systemPrompt: 'You are a helpful assistant.',
        messages: [{ toJSON: () => ({ role: 'user', content: [{ text: 'Tell me about user dark mode prefers' }] }) }],
      }

      await (manager as any)._injectMemory(mockAgent)

      expect(mockAgent.systemPrompt).toContain('<strands-memory>')
      expect(mockAgent.systemPrompt).toContain('user prefers dark mode')
      expect(mockAgent.systemPrompt).toContain('</strands-memory>')
      expect(mockAgent.systemPrompt).toMatch(/^You are a helpful assistant\./)
    })

    it('should strip previous injection block before re-injecting', async () => {
      await store1.add('user prefers dark mode')

      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
        injection: true,
      })

      const mockAgent = {
        systemPrompt: 'You are a helper.\n\n<strands-memory>\n- old fact\n</strands-memory>',
        messages: [{ toJSON: () => ({ role: 'user', content: [{ text: 'Tell me about user dark mode prefers' }] }) }],
      }

      await (manager as any)._injectMemory(mockAgent)

      expect(mockAgent.systemPrompt).not.toContain('old fact')
      expect(mockAgent.systemPrompt).toContain('user prefers dark mode')
      const openTags = (mockAgent.systemPrompt as string).split('<strands-memory>').length - 1
      expect(openTags).toBe(1)
    })

    it('should skip injection when no substantive user message exists', async () => {
      await store1.add('some fact about testing')

      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
        injection: true,
      })

      const mockAgent = {
        systemPrompt: 'You are a helper.',
        messages: [{ toJSON: () => ({ role: 'user', content: [{ text: 'hi' }] }) }],
      }

      await (manager as any)._injectMemory(mockAgent)
      expect(mockAgent.systemPrompt).toBe('You are a helper.')
    })

    it('should skip injection when search returns no results', async () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
        injection: true,
      })

      const mockAgent = {
        systemPrompt: 'You are a helper.',
        messages: [{ toJSON: () => ({ role: 'user', content: [{ text: 'Tell me about quantum physics' }] }) }],
      }

      await (manager as any)._injectMemory(mockAgent)
      expect(mockAgent.systemPrompt).toBe('You are a helper.')
    })

    it('should use custom query function when provided', async () => {
      await store1.add('fact about custom queries and testing')

      const customQuery = vi.fn().mockReturnValue('custom queries testing')

      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
        injection: { query: customQuery },
      })

      const mockAgent = {
        systemPrompt: 'Base prompt.',
        messages: [{ toJSON: () => ({ role: 'user', content: [{ text: 'something else entirely' }] }) }],
      }

      await (manager as any)._injectMemory(mockAgent)

      expect(customQuery).toHaveBeenCalled()
      expect(mockAgent.systemPrompt).toContain('custom queries')
    })

    it('should use custom format function when provided', async () => {
      await store1.add('user likes TypeScript')

      const customFormat = vi.fn().mockReturnValue('[MEMORY] user likes TypeScript [/MEMORY]')

      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
        injection: { format: customFormat },
      })

      const mockAgent = {
        systemPrompt: 'Base prompt.',
        messages: [{ toJSON: () => ({ role: 'user', content: [{ text: 'What languages do I use?' }] }) }],
      }

      await (manager as any)._injectMemory(mockAgent)

      expect(customFormat).toHaveBeenCalled()
      expect(mockAgent.systemPrompt).toContain('[MEMORY] user likes TypeScript [/MEMORY]')
    })

    it('should handle undefined system prompt', async () => {
      await store1.add('fact about undefined prompts')

      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
        injection: true,
      })

      const mockAgent = {
        systemPrompt: undefined as string | undefined,
        messages: [{ toJSON: () => ({ role: 'user', content: [{ text: 'Tell me about undefined prompts' }] }) }],
      }

      await (manager as any)._injectMemory(mockAgent)

      expect(mockAgent.systemPrompt).toContain('<strands-memory>')
      expect(mockAgent.systemPrompt).toContain('fact about undefined prompts')
    })
  })

  describe('fan-out enqueue', () => {
    it('should enqueue to ALL stores with tool trigger', async () => {
      const manager = new MemoryManager({
        stores: [
          { store: store1, ingestion: { trigger: 'tool' } },
          { store: store2, ingestion: { trigger: 'tool' } },
        ],
      })

      manager.enqueue('shared fact about dogs')
      await manager.flush()

      const results1 = await store1.search('dogs')
      const results2 = await store2.search('dogs')
      expect(results1).toHaveLength(1)
      expect(results2).toHaveLength(1)
    })

    it('should handle partial failures across stores in fan-out', async () => {
      const failingStore = {
        search: store2.search.bind(store2),
        add: vi.fn().mockRejectedValue(new Error('network error')),
        delete: store2.delete.bind(store2),
      }

      const manager = new MemoryManager({
        stores: [
          { store: store1, ingestion: { trigger: 'tool' } },
          { store: failingStore, ingestion: { trigger: 'tool' } },
        ],
      })

      await manager.store('fact about partial failures')
      const results1 = await store1.search('partial failures')
      expect(results1).toHaveLength(1)
    })
  })

  describe('message filter', () => {
    it('should exclude toolUse and toolResult blocks by default', async () => {
      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            ingestion: { trigger: 'perTurn' },
          },
        ],
      })

      const messages: MessageData[] = [
        {
          role: 'user',
          content: [{ text: 'I like cats' }],
        },
        {
          role: 'assistant',
          content: [
            { text: 'Let me look that up' },
            { toolUse: { toolUseId: '1', name: 'search', input: { q: 'cats' } } },
          ],
        },
        {
          role: 'user',
          content: [{ toolResult: { toolUseId: '1', content: [{ text: 'cats are great' }], status: 'success' } }],
        },
        {
          role: 'assistant',
          content: [{ text: 'Cats are indeed great!' }],
        },
      ]

      await manager.onTurnComplete(messages)

      const results = await store1.search('cats')
      expect(results).toHaveLength(1)
      // Should not contain tool machinery
      expect(results[0]!.content).not.toContain('toolUse')
      expect(results[0]!.content).not.toContain('toolResult')
      // Should contain text blocks
      expect(results[0]!.content).toContain('I like cats')
      expect(results[0]!.content).toContain('Let me look that up')
      expect(results[0]!.content).toContain('Cats are indeed great!')
    })

    it('should forward everything when filter exclude is empty', async () => {
      const extractor = createMockExtractor([{ content: 'fact' }])

      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            ingestion: { trigger: 'perTurn', extractor, filter: { exclude: [] } },
          },
        ],
      })

      const messages: MessageData[] = [
        {
          role: 'assistant',
          content: [{ text: 'Looking up' }, { toolUse: { toolUseId: '1', name: 'search', input: {} } }],
        },
      ]

      await manager.onTurnComplete(messages)

      // Extractor should receive the full message (both text and toolUse blocks)
      expect(extractor.extract).toHaveBeenCalledWith(messages)
    })

    it('should apply custom filter excludes', async () => {
      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            ingestion: { trigger: 'perTurn', filter: { exclude: ['text'] } },
          },
        ],
      })

      const messages: MessageData[] = [
        {
          role: 'user',
          content: [{ text: 'I like cats' }],
        },
      ]

      await manager.onTurnComplete(messages)

      // Text was excluded, so message has no content blocks and is filtered out entirely
      const results = await store1.search('cats')
      expect(results).toHaveLength(0)
    })

    it('should drop messages that become empty after filtering', async () => {
      const extractor = createMockExtractor([{ content: 'fact' }])

      const manager = new MemoryManager({
        stores: [
          {
            store: store1,
            ingestion: { trigger: 'perTurn', extractor },
          },
        ],
      })

      const messages: MessageData[] = [
        {
          role: 'user',
          content: [{ toolResult: { toolUseId: '1', content: [{ text: 'result' }], status: 'success' } }],
        },
        {
          role: 'assistant',
          content: [{ text: 'Got it' }],
        },
      ]

      await manager.onTurnComplete(messages)

      // First message was only toolResult (excluded by default) so it's dropped
      // Only the assistant message should be passed to extractor
      expect(extractor.extract).toHaveBeenCalledWith([{ role: 'assistant', content: [{ text: 'Got it' }] }])
    })
  })

  describe('tools config', () => {
    it('should use custom search tool name and description', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
        tools: { search: { name: 'recall', description: 'Custom search desc' } },
      })

      const tools = manager.getTools()
      const searchTool = tools.find((t) => t.name === 'recall')
      expect(searchTool).toBeDefined()
      expect(searchTool!.description).toBe('Custom search desc')
    })

    it('should use custom store tool name and description', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
        tools: { store: { name: 'remember', description: 'Custom store desc' } },
      })

      const tools = manager.getTools()
      const storeTool = tools.find((t) => t.name === 'remember')
      expect(storeTool).toBeDefined()
      expect(storeTool!.description).toBe('Custom store desc')
    })

    it('should disable search tool when search is false', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
        tools: { search: false },
      })

      const tools = manager.getTools()
      expect(tools.find((t) => t.name === 'search_memory')).toBeUndefined()
      expect(tools.find((t) => t.name === 'store_memory')).toBeDefined()
    })

    it('should disable store tool when store is false', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
        tools: { store: false },
      })

      const tools = manager.getTools()
      expect(tools.find((t) => t.name === 'search_memory')).toBeDefined()
      expect(tools.find((t) => t.name === 'store_memory')).toBeUndefined()
    })

    it('should use default descriptions when ToolsConfig is empty object', () => {
      const manager = new MemoryManager({
        stores: [{ store: store1, ingestion: { trigger: 'tool' } }],
        tools: {},
      })

      const tools = manager.getTools()
      const searchTool = tools.find((t) => t.name === 'search_memory')
      const storeTool = tools.find((t) => t.name === 'store_memory')
      expect(searchTool!.description).toContain('Search long-term memory')
      expect(storeTool!.description).toContain('Store facts, preferences')
    })
  })
})
