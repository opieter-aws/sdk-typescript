import {
  BedrockAgentRuntimeClient,
  type BedrockAgentRuntimeClientConfig,
  RetrieveCommand,
  type RetrievalFilter,
} from '@aws-sdk/client-bedrock-agent-runtime'
import {
  BedrockAgentClient,
  type BedrockAgentClientConfig,
  IngestKnowledgeBaseDocumentsCommand,
  DeleteKnowledgeBaseDocumentsCommand,
} from '@aws-sdk/client-bedrock-agent'
import { v7 as uuidv7 } from 'uuid'

import type { KnowledgeEntry, KnowledgeStore } from './types.js'

export interface BedrockKnowledgeBaseStoreConfig {
  knowledgeBaseId: string
  dataSourceId?: string
  scope?: string
  scopeMetadataKey?: string
  filter?: RetrievalFilter
  runtimeClientConfig?: BedrockAgentRuntimeClientConfig
  runtimeClient?: BedrockAgentRuntimeClient
  agentClientConfig?: BedrockAgentClientConfig
  agentClient?: BedrockAgentClient
}

export class BedrockKnowledgeBaseStore implements KnowledgeStore {
  private readonly _runtimeClient: BedrockAgentRuntimeClient
  private _agentClient: BedrockAgentClient | undefined
  private readonly _agentClientConfig: BedrockAgentClientConfig | undefined
  private readonly _knowledgeBaseId: string
  private readonly _dataSourceId: string | undefined
  private readonly _scope: string | undefined
  private readonly _scopeMetadataKey: string
  private readonly _filter: RetrievalFilter | undefined

  constructor(config: BedrockKnowledgeBaseStoreConfig) {
    this._runtimeClient = config.runtimeClient ?? new BedrockAgentRuntimeClient(config.runtimeClientConfig ?? {})
    this._agentClient = config.agentClient
    this._agentClientConfig = config.agentClientConfig
    this._knowledgeBaseId = config.knowledgeBaseId
    this._dataSourceId = config.dataSourceId
    this._scope = config.scope
    this._scopeMetadataKey = config.scopeMetadataKey ?? 'namespace'

    if (config.filter) {
      this._filter = config.filter
    } else if (config.scope) {
      this._filter = {
        equals: {
          key: this._scopeMetadataKey,
          value: config.scope,
        },
      }
    }
  }

  async search(query: string, options?: Record<string, unknown>): Promise<KnowledgeEntry[]> {
    const limit = typeof options?.limit === 'number' ? options.limit : 10

    const response = await this._runtimeClient.send(
      new RetrieveCommand({
        knowledgeBaseId: this._knowledgeBaseId,
        retrievalQuery: { text: query },
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: limit,
            ...(this._filter && { filter: this._filter }),
          },
        },
      })
    )

    return (response.retrievalResults ?? []).map((result, index) => {
      const metadata: Record<string, unknown> = {}
      if (result.metadata) {
        for (const [key, value] of Object.entries(result.metadata)) {
          metadata[key] = value
        }
      }
      if (result.location) {
        metadata._location = result.location
      }
      if (result.score != null) {
        metadata.score = result.score
      }

      return {
        id: this._resolveId(result.location?.customDocumentLocation?.id, result.metadata, index),
        content: result.content?.text ?? '',
        metadata,
      }
    })
  }

  async add(content: string, metadata?: Record<string, unknown>): Promise<void> {
    const dataSourceId = this._requireDataSourceId()
    const id = uuidv7()

    const inlineAttributes: Array<{
      key: string
      value:
        | { type: 'STRING'; stringValue: string }
        | { type: 'NUMBER'; numberValue: number }
        | { type: 'BOOLEAN'; booleanValue: boolean }
    }> = []

    if (this._scope) {
      inlineAttributes.push({
        key: this._scopeMetadataKey,
        value: { type: 'STRING' as const, stringValue: this._scope },
      })
    }

    if (metadata) {
      for (const [key, value] of Object.entries(metadata)) {
        if (typeof value === 'string') {
          inlineAttributes.push({
            key,
            value: { type: 'STRING' as const, stringValue: value },
          })
        } else if (typeof value === 'number') {
          inlineAttributes.push({
            key,
            value: { type: 'NUMBER' as const, numberValue: value },
          })
        } else if (typeof value === 'boolean') {
          inlineAttributes.push({
            key,
            value: { type: 'BOOLEAN' as const, booleanValue: value },
          })
        }
      }
    }

    await this._getAgentClient().send(
      new IngestKnowledgeBaseDocumentsCommand({
        knowledgeBaseId: this._knowledgeBaseId,
        dataSourceId,
        documents: [
          {
            content: {
              dataSourceType: 'CUSTOM',
              custom: {
                customDocumentIdentifier: { id },
                sourceType: 'IN_LINE',
                inlineContent: {
                  type: 'TEXT',
                  textContent: { data: content },
                },
              },
            },
            metadata: {
              type: 'IN_LINE_ATTRIBUTE',
              inlineAttributes,
            },
          },
        ],
      })
    )
  }

  async delete(id: string): Promise<void> {
    const dataSourceId = this._requireDataSourceId()

    await this._getAgentClient().send(
      new DeleteKnowledgeBaseDocumentsCommand({
        knowledgeBaseId: this._knowledgeBaseId,
        dataSourceId,
        documentIdentifiers: [
          {
            dataSourceType: 'CUSTOM',
            custom: { id },
          },
        ],
      })
    )
  }

  private _requireDataSourceId(): string {
    if (!this._dataSourceId) {
      throw new Error(
        'BedrockKnowledgeBaseStore: dataSourceId is required for write operations. ' +
          'Provide it in the config to enable add() and delete().'
      )
    }
    return this._dataSourceId
  }

  private _getAgentClient(): BedrockAgentClient {
    if (!this._agentClient) {
      this._agentClient = new BedrockAgentClient(this._agentClientConfig ?? {})
    }
    return this._agentClient
  }

  private _resolveId(
    customId: string | undefined,
    metadata: Record<string, unknown> | undefined | null,
    index: number
  ): string {
    if (customId) {
      return customId
    }
    if (metadata?.['id'] && typeof metadata['id'] === 'string') {
      return metadata['id']
    }
    return `result-${index}`
  }
}
