import type { MessageData } from '../types/messages.js'
import type { Extractor } from './extractor/types.js'

export interface KnowledgeEntry {
  id: string
  content: string
  metadata?: Record<string, unknown>
}

export interface KnowledgeStore {
  search(query: string, options?: Record<string, unknown>): Promise<KnowledgeEntry[]>
  add?(content: string, metadata?: Record<string, unknown>): Promise<void>
  delete?(id: string): Promise<void>
}

export function hasAdd(
  store: KnowledgeStore
): store is KnowledgeStore & { add(content: string, metadata?: Record<string, unknown>): Promise<void> } {
  return typeof store.add === 'function'
}

export function hasDelete(store: KnowledgeStore): store is KnowledgeStore & { delete(id: string): Promise<void> } {
  return typeof store.delete === 'function'
}

export type IngestionTrigger = 'tool' | 'perTurn' | 'onEviction' | 'scheduled'

export type ContentBlockType =
  | 'text'
  | 'toolUse'
  | 'toolResult'
  | 'reasoning'
  | 'cachePoint'
  | 'guardContent'
  | 'image'
  | 'video'
  | 'document'
  | 'citations'

export interface MessageFilter {
  exclude: ContentBlockType[]
}

export interface IngestionConfig {
  trigger: IngestionTrigger | IngestionTrigger[]
  extractor?: Extractor
  interval?: number
  filter?: MessageFilter
}

export interface StoreConfig {
  store: KnowledgeStore
  limit?: number
  ingestion?: IngestionConfig
}

export interface InjectionConfig {
  query?: (messages: MessageData[]) => string | undefined
  maxTokens?: number
  format?: (entries: KnowledgeEntry[]) => string
}

export interface ToolConfig {
  name?: string
  description?: string
}

export interface ToolsConfig {
  search?: boolean | ToolConfig
  store?: boolean | ToolConfig
}

export interface MemoryManagerConfig {
  stores: StoreConfig[]
  tools?: boolean | ToolsConfig
  injection?: boolean | InjectionConfig
}
