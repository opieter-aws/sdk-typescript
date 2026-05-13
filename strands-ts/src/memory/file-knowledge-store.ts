import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { v7 as uuidv7 } from 'uuid'

import type { KnowledgeEntry, MutableKnowledgeStore } from './types.js'
import type { JSONValue } from '../types/json.js'

export interface FileKnowledgeStoreConfig {
  baseDir: string
}

export class FileKnowledgeStore implements MutableKnowledgeStore {
  private static readonly VALID_NAMESPACE = /^[a-zA-Z0-9_-]+$/

  private readonly _baseDir: string

  constructor(config: FileKnowledgeStoreConfig) {
    this._baseDir = config.baseDir
  }

  private _validateNamespace(namespace: string): void {
    if (!FileKnowledgeStore.VALID_NAMESPACE.test(namespace)) {
      throw new Error(
        `Invalid namespace "${namespace}": must contain only alphanumeric characters, hyphens, and underscores`
      )
    }
  }

  async search(namespace: string, query: string, limit?: number): Promise<KnowledgeEntry[]> {
    this._validateNamespace(namespace)
    const entries = await this._readAll(namespace)
    const lowerQuery = query.toLowerCase()

    if (lowerQuery.trim().length === 0) {
      return []
    }

    const matched = entries
      .filter((entry) => entry.content.toLowerCase().includes(lowerQuery))
      .map((entry) => ({ ...entry, score: 1 }))

    return limit ? matched.slice(0, limit) : matched
  }

  async store(namespace: string, content: string, metadata?: Record<string, JSONValue>): Promise<string> {
    this._validateNamespace(namespace)
    const id = uuidv7()
    const entry: KnowledgeEntry = { id, content, namespace }
    if (metadata) {
      entry.metadata = metadata
    }

    const dir = this._entriesDir(namespace)
    await fs.mkdir(dir, { recursive: true })
    const finalPath = path.join(dir, `${id}.json`)
    const tmpPath = `${finalPath}.tmp`
    await fs.writeFile(tmpPath, JSON.stringify(entry, null, 2))
    await fs.rename(tmpPath, finalPath)
    return id
  }

  async delete(namespace: string, id: string): Promise<void> {
    this._validateNamespace(namespace)
    const filePath = this._entryPath(namespace, id)
    try {
      await fs.unlink(filePath)
    } catch {
      throw new Error(`Entry not found: ${id}`)
    }
  }

  private _entriesDir(namespace: string): string {
    return path.join(this._baseDir, namespace, 'entries')
  }

  private _entryPath(namespace: string, id: string): string {
    return path.join(this._entriesDir(namespace), `${id}.json`)
  }

  private async _readAll(namespace: string): Promise<KnowledgeEntry[]> {
    const dir = this._entriesDir(namespace)
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
        entry.namespace = namespace
        entries.push(entry)
      } catch {
        // skip malformed files
      }
    }
    return entries
  }
}
