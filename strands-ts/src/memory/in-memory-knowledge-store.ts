import { v7 as uuidv7 } from 'uuid'

import type { KnowledgeEntry, KnowledgeStore } from './types.js'

export class InMemoryKnowledgeStore implements KnowledgeStore {
  private readonly _entries: KnowledgeEntry[] = []

  async search(query: string, options?: Record<string, unknown>): Promise<KnowledgeEntry[]> {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)

    if (tokens.length === 0) return []

    const limit = typeof options?.limit === 'number' ? options.limit : undefined

    const scored = this._entries
      .map((entry) => {
        const searchable = this._buildSearchableText(entry)
        const hits = tokens.filter((t) => searchable.includes(t)).length
        return { entry, hits }
      })
      .filter(({ hits }) => hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .map(({ entry, hits }) => ({
        ...entry,
        metadata: { ...entry.metadata, score: hits / tokens.length },
      }))

    return limit ? scored.slice(0, limit) : scored
  }

  private _buildSearchableText(entry: KnowledgeEntry): string {
    let text = entry.content.toLowerCase()
    if (entry.metadata) {
      const metaValues = Object.entries(entry.metadata)
        .filter(([key]) => !key.startsWith('strands_'))
        .map(([, value]) => String(value))
        .join(' ')
      text += ' ' + metaValues.toLowerCase()
    }
    return text
  }

  async add(content: string, metadata?: Record<string, unknown>): Promise<void> {
    const id = uuidv7()
    const entry: KnowledgeEntry = { id, content }
    if (metadata) {
      entry.metadata = metadata
    }

    this._entries.push(entry)
  }

  async delete(id: string): Promise<void> {
    const index = this._entries.findIndex((e) => e.id === id)
    if (index === -1) {
      throw new Error(`Entry not found: ${id}`)
    }

    this._entries.splice(index, 1)
  }
}
