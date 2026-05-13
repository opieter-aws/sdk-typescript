import { v7 as uuidv7 } from 'uuid'

import type { KnowledgeEntry, MutableKnowledgeStore } from './types.js'
import type { JSONValue } from '../types/json.js'

export class InMemoryKnowledgeStore implements MutableKnowledgeStore {
  private readonly _store = new Map<string, KnowledgeEntry[]>()

  async search(namespace: string, query: string, limit?: number): Promise<KnowledgeEntry[]> {
    const entries = this._store.get(namespace) ?? []
    const lowerQuery = query.toLowerCase()

    if (lowerQuery.trim().length === 0) {
      return []
    }

    const matched = entries
      .filter((entry) => entry.content.toLowerCase().includes(lowerQuery))
      .map((entry) => ({ ...entry, namespace, score: 1 }))

    return limit ? matched.slice(0, limit) : matched
  }

  async store(namespace: string, content: string, metadata?: Record<string, JSONValue>): Promise<string> {
    const id = uuidv7()
    const entry: KnowledgeEntry = { id, content }
    if (metadata) {
      entry.metadata = metadata
    }

    const entries = this._store.get(namespace) ?? []
    entries.push(entry)
    this._store.set(namespace, entries)

    return id
  }

  async delete(namespace: string, id: string): Promise<void> {
    const entries = this._store.get(namespace)
    if (!entries) {
      throw new Error(`Entry not found: ${id}`)
    }

    const index = entries.findIndex((e) => e.id === id)
    if (index === -1) {
      throw new Error(`Entry not found: ${id}`)
    }

    entries.splice(index, 1)
  }
}
