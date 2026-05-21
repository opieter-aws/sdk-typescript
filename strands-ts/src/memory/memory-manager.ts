import type { Plugin } from '../plugins/plugin.js'
import type { Tool } from '../tools/tool.js'
import type { LocalAgent } from '../types/agent.js'
import type { MessageData } from '../types/messages.js'
import { AfterInvocationEvent, BeforeInvocationEvent } from '../hooks/events.js'
import { tool } from '../tools/tool-factory.js'
import { z } from 'zod'
import { logger } from '../logging/logger.js'

import type {
  ContentBlockType,
  InjectionConfig,
  IngestionTrigger,
  KnowledgeEntry,
  MemoryManagerConfig,
  StoreConfig,
  ToolsConfig,
} from './types.js'
import { hasAdd } from './types.js'
import type { ContentBlockData } from '../types/messages.js'

const DEFAULT_SEARCH_DESCRIPTION =
  'Search long-term memory for facts, preferences, or context from previous conversations. Use when you need background about the user or topic that may have been discussed before.'
const DEFAULT_STORE_DESCRIPTION =
  'Store facts, preferences, or decisions that should be remembered across conversations. Use when the user shares something worth recalling later.'

const DEFAULT_FILTER: ContentBlockType[] = ['toolUse', 'toolResult']

export class MemoryManager implements Plugin {
  readonly name = 'strands:memory-manager'

  private readonly _stores: readonly StoreConfig[]
  private readonly _toolsConfig: ToolsConfig | false
  private readonly _injectionConfig: InjectionConfig | undefined
  private _turnCount = 0
  private _writeChain: Promise<void> = Promise.resolve()
  private readonly _highWaterMarks = new Map<StoreConfig, number>()

  private static readonly SENTINEL_OPEN = '<strands-memory>'
  private static readonly SENTINEL_CLOSE = '</strands-memory>'

  constructor(config: MemoryManagerConfig) {
    this._stores = config.stores

    if (config.tools === false) {
      this._toolsConfig = false
    } else if (config.tools === true || config.tools === undefined) {
      this._toolsConfig = {}
    } else {
      this._toolsConfig = config.tools
    }

    if (config.injection === true) {
      this._injectionConfig = {}
    } else if (typeof config.injection === 'object') {
      this._injectionConfig = config.injection
    }
  }

  initAgent(agent: LocalAgent): void {
    if (this._injectionConfig) {
      agent.addHook(BeforeInvocationEvent, async (event) => {
        await this._injectMemory(event.agent)
      })
    }

    agent.addHook(AfterInvocationEvent, async (event) => {
      const messages = event.agent.messages.map((m) => m.toJSON())
      this.onTurnComplete(messages).catch((err) => {
        logger.warn('MemoryManager: onTurnComplete failed', err)
      })
      await this.flush()
    })
  }

  getTools(): Tool[] {
    if (this._toolsConfig === false) return []

    const tools: Tool[] = []
    const searchConfig = this._toolsConfig.search
    if (searchConfig !== false) {
      tools.push(this._createSearchTool(typeof searchConfig === 'object' ? searchConfig : undefined))
    }

    const storeConfig = this._toolsConfig.store
    if (storeConfig !== false && this._stores.some((config) => this._hasTrigger(config, 'tool'))) {
      tools.push(this._createStoreTool(typeof storeConfig === 'object' ? storeConfig : undefined))
    }
    return tools
  }

  async search(query: string, options?: { limit?: number }): Promise<KnowledgeEntry[]> {
    const settled = await Promise.allSettled(
      this._stores.map(async (config) => {
        return config.store.search(query, { limit: config.limit ?? 10 })
      })
    )

    const perStore: KnowledgeEntry[][] = settled.map((r) =>
      r.status === 'fulfilled'
        ? r.value
        : (r.status === 'rejected' && logger.warn('MemoryManager: store search failed', r.reason), [])
    )

    const merged: KnowledgeEntry[] = []
    const seen = new Set<string>()
    let rank = 0
    let hasMore = true

    while (hasMore) {
      hasMore = false
      for (const results of perStore) {
        if (rank < results.length) {
          hasMore = true
          const entry = results[rank]!
          if (!seen.has(entry.id)) {
            seen.add(entry.id)
            merged.push(entry)
          }
        }
      }
      rank++
    }

    if (options?.limit) return merged.slice(0, options.limit)
    return merged
  }

  async store(content: string, metadata?: Record<string, unknown>): Promise<void> {
    const toolStores = this._stores.filter((config) => this._hasTrigger(config, 'tool'))
    if (toolStores.length === 0) {
      throw new Error('MemoryManager: no store configured with "tool" ingestion trigger')
    }

    const taggedMetadata: Record<string, unknown> = { ...metadata, strands_source: 'tool' }

    const settled = await Promise.allSettled(
      toolStores.map((config) => {
        if (!hasAdd(config.store)) {
          return Promise.reject(new Error('Store does not support add()'))
        }
        return config.store.add(content, taggedMetadata)
      })
    )

    for (const result of settled) {
      if (result.status === 'rejected') {
        logger.warn('MemoryManager: store write failed', result.reason)
      }
    }
  }

  enqueue(content: string, metadata?: Record<string, unknown>): void {
    const toolStores = this._stores.filter((config) => this._hasTrigger(config, 'tool'))
    if (toolStores.length === 0) {
      throw new Error('MemoryManager: no store configured with "tool" ingestion trigger')
    }

    const taggedMetadata: Record<string, unknown> = { ...metadata, strands_source: 'tool' }

    for (const config of toolStores) {
      if (!hasAdd(config.store)) continue
      const store = config.store
      this._writeChain = this._writeChain.then(async () => {
        try {
          await store.add(content, taggedMetadata)
        } catch (err) {
          logger.warn('MemoryManager: background write failed', err)
        }
      })
    }
  }

  flush(): Promise<void> {
    return this._writeChain
  }

  async onTurnComplete(allMessages: MessageData[]): Promise<void> {
    this._turnCount++

    const configs = this._stores.filter((config) => {
      if (!config.ingestion) return false
      if (this._hasTrigger(config, 'perTurn')) return true
      if (this._hasTrigger(config, 'scheduled')) {
        const every = config.ingestion.interval ?? 5
        return this._turnCount % every === 0
      }
      return false
    })

    await Promise.all(
      configs.map((config) => {
        const hwm = this._highWaterMarks.get(config) ?? 0
        const unprocessed = allMessages.slice(hwm)
        this._highWaterMarks.set(config, allMessages.length)
        if (unprocessed.length === 0) return Promise.resolve()
        return this._ingest(config, unprocessed)
      })
    )
  }

  async onEviction(evictedMessages: MessageData[]): Promise<void> {
    for (const [config, hwm] of this._highWaterMarks) {
      this._highWaterMarks.set(config, Math.max(0, hwm - evictedMessages.length))
    }

    const configs = this._stores.filter((config) => this._hasTrigger(config, 'onEviction'))
    await Promise.all(configs.map((config) => this._ingest(config, evictedMessages)))
  }

  private async _injectMemory(agent: LocalAgent): Promise<void> {
    const currentPrompt = typeof agent.systemPrompt === 'string' ? agent.systemPrompt : undefined
    const stripped = this._stripMemoryBlock(currentPrompt)
    if (stripped !== currentPrompt) {
      if (stripped) {
        agent.systemPrompt = stripped
      } else {
        delete agent.systemPrompt
      }
    }

    const messages = agent.messages.map((m) => m.toJSON())
    const query = this._deriveQuery(messages)
    if (!query) return

    const results = await this.search(query)
    if (results.length === 0) return

    const block = this._formatInjection(results)
    agent.systemPrompt = this._appendToSystemPrompt(
      typeof agent.systemPrompt === 'string' ? agent.systemPrompt : undefined,
      block
    )
  }

  private _stripMemoryBlock(prompt: string | undefined): string | undefined {
    if (!prompt) return prompt
    const start = prompt.indexOf(MemoryManager.SENTINEL_OPEN)
    if (start === -1) return prompt
    const end = prompt.indexOf(MemoryManager.SENTINEL_CLOSE, start)
    if (end === -1) return prompt
    const before = prompt.slice(0, start).trimEnd()
    const after = prompt.slice(end + MemoryManager.SENTINEL_CLOSE.length).trimStart()
    return [before, after].filter(Boolean).join('\n') || undefined
  }

  private _deriveQuery(messages: MessageData[]): string | undefined {
    if (this._injectionConfig?.query) {
      return this._injectionConfig.query(messages)
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!
      if (msg.role !== 'user') continue
      const text = msg.content
        .filter((block): block is { text: string } => 'text' in block && typeof block.text === 'string')
        .map((b) => b.text)
        .join(' ')
      if (text.length > 10) return text
    }
    return undefined
  }

  private _formatInjection(entries: KnowledgeEntry[]): string {
    if (this._injectionConfig?.format) {
      return this._injectionConfig.format(entries)
    }
    const bullets = entries.map((e) => `- ${e.content}`).join('\n')
    return `${MemoryManager.SENTINEL_OPEN}\n${bullets}\n${MemoryManager.SENTINEL_CLOSE}`
  }

  private _appendToSystemPrompt(prompt: string | undefined, block: string): string {
    if (!prompt) return block
    return `${prompt}\n\n${block}`
  }

  private async _ingest(config: StoreConfig, messages: MessageData[]): Promise<void> {
    try {
      if (!hasAdd(config.store)) return
      const store = config.store
      const filtered = this._applyFilter(messages, config)

      if (config.ingestion?.extractor) {
        const extracted = await config.ingestion.extractor.extract(filtered)
        await Promise.all(
          extracted.map((item) => store.add(item.content, this._tagMetadata('extraction', item.metadata)))
        )
      } else {
        const content = this._messagesToText(filtered)
        if (content) {
          await store.add(content, this._tagMetadata('raw'))
        }
      }
    } catch (err) {
      logger.warn('MemoryManager: ingestion failed', err)
    }
  }

  private _applyFilter(messages: MessageData[], config: StoreConfig): MessageData[] {
    const exclude = config.ingestion?.filter?.exclude ?? DEFAULT_FILTER
    if (exclude.length === 0) return messages

    return messages
      .map((msg) => ({
        ...msg,
        content: msg.content.filter((block) => !this._shouldExcludeBlock(block, exclude)),
      }))
      .filter((msg) => msg.content.length > 0)
  }

  private _shouldExcludeBlock(block: ContentBlockData, exclude: ContentBlockType[]): boolean {
    if ('text' in block) return exclude.includes('text')
    if ('toolUse' in block) return exclude.includes('toolUse')
    if ('toolResult' in block) return exclude.includes('toolResult')
    if ('reasoning' in block) return exclude.includes('reasoning')
    if ('cachePoint' in block) return exclude.includes('cachePoint')
    if ('guardContent' in block) return exclude.includes('guardContent')
    if ('image' in block) return exclude.includes('image')
    if ('video' in block) return exclude.includes('video')
    if ('document' in block) return exclude.includes('document')
    if ('citations' in block) return exclude.includes('citations')
    return false
  }

  private _messagesToText(messages: MessageData[]): string {
    return messages
      .map((m) => {
        const texts = m.content
          .filter((block): block is { text: string } => 'text' in block && typeof block.text === 'string')
          .map((block) => block.text)
        if (texts.length === 0) return ''
        return `${m.role}: ${texts.join(' ')}`
      })
      .filter(Boolean)
      .join('\n')
  }

  private _tagMetadata(source: 'extraction' | 'raw', metadata?: Record<string, unknown>): Record<string, unknown> {
    return {
      ...metadata,
      strands_source: source,
      strands_extractedAt: new Date().toISOString(),
    }
  }

  private _hasTrigger(config: StoreConfig, trigger: IngestionTrigger): boolean {
    if (!config.ingestion) return false
    const triggers = Array.isArray(config.ingestion.trigger) ? config.ingestion.trigger : [config.ingestion.trigger]
    return triggers.includes(trigger)
  }

  private _createSearchTool(config?: { name?: string; description?: string }): Tool {
    return tool({
      name: config?.name ?? 'search_memory',
      description: config?.description ?? DEFAULT_SEARCH_DESCRIPTION,
      inputSchema: z.object({
        query: z.string().describe('What to search for'),
        limit: z.number().optional().describe('Maximum number of results'),
      }),
      callback: async (input) => {
        logger.debug(`search_memory query="${input.query}" limit=${input.limit}`)
        const options: { limit?: number } = {}
        if (input.limit !== undefined) options.limit = input.limit
        const results = await this.search(input.query, options)
        logger.debug(`search_memory returned ${results.length} results`)
        return results as unknown as ReturnType<typeof JSON.parse>
      },
    })
  }

  private _createStoreTool(config?: { name?: string; description?: string }): Tool {
    return tool({
      name: config?.name ?? 'store_memory',
      description: config?.description ?? DEFAULT_STORE_DESCRIPTION,
      inputSchema: z.object({
        entries: z.array(z.string()).describe('Facts to store in long-term memory'),
      }),
      callback: (input) => {
        for (const content of input.entries) {
          this.enqueue(content)
        }
        return { stored: true }
      },
    })
  }
}
