import type { Plugin } from '../plugins/plugin.js'
import type { Tool } from '../tools/tool.js'
import type { LocalAgent } from '../types/agent.js'
import type { MessageData } from '../types/messages.js'
import { AfterInvocationEvent } from '../hooks/events.js'
import { tool } from '../tools/tool-factory.js'
import { z } from 'zod'
import { logger } from '../logging/logger.js'

import type { KnowledgeEntry, KnowledgeStore, MutableKnowledgeStore } from './types.js'
import type { JSONValue } from '../types/json.js'
import type { Extractor } from './extractor/types.js'

const DEFAULT_NAMESPACE = 'default'

export type IngestionTrigger = 'tool' | 'perTurn' | 'onEviction' | 'scheduled'

export interface IngestionConfig {
  trigger: IngestionTrigger | IngestionTrigger[]
  extractor?: Extractor
  interval?: number
}

export interface StoreConfig {
  store: KnowledgeStore | MutableKnowledgeStore
  namespace?: string
  limit?: number
  ingestion?: IngestionConfig
}

export interface MemoryManagerConfig {
  stores: StoreConfig[]
  tools?: boolean
}

export class MemoryManager implements Plugin {
  readonly name = 'strands:memory-manager'

  private readonly _stores: readonly StoreConfig[]
  private readonly _includeTools: boolean
  private _turnCount = 0

  constructor(config: MemoryManagerConfig) {
    this._stores = config.stores
    this._includeTools = config.tools ?? true
  }

  initAgent(agent: LocalAgent): void {
    agent.addHook(AfterInvocationEvent, (event) => {
      const messages = event.agent.messages.map((m) => m.toJSON())
      this.onTurnComplete(messages).catch((err) => {
        logger.warn('MemoryManager: onTurnComplete failed', err)
      })
    })
  }

  getTools(): Tool[] {
    if (!this._includeTools) return []

    const tools: Tool[] = [this._createSearchTool()]
    if (this._stores.some((config) => this._hasTrigger(config, 'tool'))) {
      tools.push(this._createStoreTool())
    }
    return tools
  }

  async search(query: string, limit?: number): Promise<KnowledgeEntry[]> {
    const settled = await Promise.allSettled(
      this._stores.map(async (config) => {
        const storeLimit = limit ?? config.limit ?? 10
        return config.store.search(this._resolveNamespace(config), query, storeLimit)
      })
    )

    const merged: KnowledgeEntry[] = []
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        merged.push(...result.value)
      } else {
        logger.warn('MemoryManager: store search failed', result.reason)
      }
    }
    const seen = new Set<string>()
    const deduped = merged.filter((entry) => {
      if (seen.has(entry.id)) return false
      seen.add(entry.id)
      return true
    })

    deduped.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    return deduped
  }

  async store(content: string, metadata?: Record<string, JSONValue>): Promise<string> {
    const toolStore = this._stores.find((config) => this._hasTrigger(config, 'tool'))
    if (!toolStore) {
      throw new Error('MemoryManager: no store configured with "tool" ingestion trigger')
    }

    const taggedMetadata: Record<string, JSONValue> = {
      ...metadata,
      _source: 'tool',
    }
    return (toolStore.store as MutableKnowledgeStore).store(this._resolveNamespace(toolStore), content, taggedMetadata)
  }

  async onTurnComplete(newMessages: MessageData[]): Promise<void> {
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

    await Promise.all(configs.map((config) => this._ingest(config, newMessages)))
  }

  async onEviction(messages: MessageData[]): Promise<void> {
    const configs = this._stores.filter((config) => this._hasTrigger(config, 'onEviction'))
    await Promise.all(configs.map((config) => this._ingest(config, messages)))
  }

  private async _ingest(config: StoreConfig, messages: MessageData[]): Promise<void> {
    try {
      const mutableStore = config.store as MutableKnowledgeStore
      const namespace = this._resolveNamespace(config)

      if (config.ingestion?.extractor) {
        const extracted = await config.ingestion.extractor.extract(messages)
        await Promise.all(
          extracted.map((item) =>
            mutableStore.store(namespace, item.content, this._tagExtractionMetadata(item.metadata))
          )
        )
      } else {
        const content = this._messagesToText(messages)
        if (content) {
          await mutableStore.store(namespace, content, this._tagExtractionMetadata())
        }
      }
    } catch (err) {
      logger.warn(`MemoryManager: ingestion failed for namespace=${this._resolveNamespace(config)}`, err)
    }
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

  private _resolveNamespace(config: StoreConfig): string {
    return config.namespace ?? DEFAULT_NAMESPACE
  }

  private _tagExtractionMetadata(metadata?: Record<string, JSONValue>): Record<string, JSONValue> {
    return {
      ...metadata,
      _source: 'extraction',
      _extractedAt: new Date().toISOString(),
    }
  }

  private _hasTrigger(config: StoreConfig, trigger: IngestionTrigger): boolean {
    if (!config.ingestion) return false
    const triggers = Array.isArray(config.ingestion.trigger) ? config.ingestion.trigger : [config.ingestion.trigger]
    return triggers.includes(trigger)
  }

  private _createSearchTool(): Tool {
    return tool({
      name: 'search_memory',
      description: 'Search long-term memory for stored facts, preferences, and knowledge.',
      inputSchema: z.object({
        query: z.string().describe('What to search for'),
        limit: z.number().optional().describe('Maximum number of results'),
      }),
      callback: async (input) => {
        const results = await this.search(input.query, input.limit)
        return results as unknown as ReturnType<typeof JSON.parse>
      },
    })
  }

  private _createStoreTool(): Tool {
    return tool({
      name: 'store_memory',
      description: 'Store a fact in long-term memory for future recall.',
      inputSchema: z.object({
        content: z.string().describe('The fact to remember'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Optional metadata for the stored fact'),
      }),
      callback: async (input) => {
        const id = await this.store(input.content, input.metadata as Record<string, JSONValue> | undefined)
        return { id, stored: true }
      },
    })
  }
}
