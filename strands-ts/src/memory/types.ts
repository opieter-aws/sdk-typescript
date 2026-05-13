import type { JSONValue } from '../types/json.js'

export interface KnowledgeEntry {
  id: string
  content: string
  namespace?: string
  score?: number
  metadata?: Record<string, JSONValue>
}

export interface KnowledgeStore {
  search(namespace: string, query: string, limit?: number): Promise<KnowledgeEntry[]>
}

export interface MutableKnowledgeStore extends KnowledgeStore {
  store(namespace: string, content: string, metadata?: Record<string, JSONValue>): Promise<string>
  delete(namespace: string, id: string): Promise<void>
}
