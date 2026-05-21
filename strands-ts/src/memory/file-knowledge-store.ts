import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { v7 as uuidv7 } from 'uuid'

import type { KnowledgeEntry, KnowledgeStore } from './types.js'

export interface FileKnowledgeStoreConfig {
  baseDir: string
}

export class FileKnowledgeStore implements KnowledgeStore {
  private readonly _baseDir: string

  constructor(config: FileKnowledgeStoreConfig) {
    this._baseDir = config.baseDir
  }

  async search(query: string, options?: Record<string, unknown>): Promise<KnowledgeEntry[]> {
    const entries = await this._readAll()
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)

    if (tokens.length === 0) return []

    const limit = typeof options?.limit === 'number' ? options.limit : undefined

    const scored = entries
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

    const dir = this._entriesDir()
    await fs.mkdir(dir, { recursive: true })
    const finalPath = path.join(dir, `${id}.json`)
    const tmpPath = `${finalPath}.tmp`
    await fs.writeFile(tmpPath, JSON.stringify(entry, null, 2))
    await fs.rename(tmpPath, finalPath)
  }

  async delete(id: string): Promise<void> {
    const filePath = this._entryPath(id)
    try {
      await fs.unlink(filePath)
    } catch {
      throw new Error(`Entry not found: ${id}`)
    }
  }

  private _entriesDir(): string {
    return path.join(this._baseDir, 'entries')
  }

  private _entryPath(id: string): string {
    return path.join(this._entriesDir(), `${id}.json`)
  }

  private async _readAll(): Promise<KnowledgeEntry[]> {
    const dir = this._entriesDir()
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch {
      return []
    }

    const entries: KnowledgeEntry[] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf-8')
        const entry = JSON.parse(raw) as KnowledgeEntry
        entries.push(entry)
      } catch {
        // skip malformed files
      }
    }
    return entries
  }
}
