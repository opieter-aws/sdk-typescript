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

import type { KnowledgeEntry, KnowledgeStore, MutableKnowledgeStore } from './types.js'
import type { JSONValue } from '../types/json.js'

export interface BedrockKnowledgeBaseStoreConfig {
  knowledgeBaseId: string
  dataSourceId?: string
  runtimeClientConfig?: BedrockAgentRuntimeClientConfig
  runtimeClient?: BedrockAgentRuntimeClient
  agentClientConfig?: BedrockAgentClientConfig
  agentClient?: BedrockAgentClient
  namespaceMetadataKey?: string
}

export class BedrockKnowledgeBaseStore implements KnowledgeStore, MutableKnowledgeStore {
  private readonly _runtimeClient: BedrockAgentRuntimeClient
  private _agentClient: BedrockAgentClient | undefined
  private readonly _agentClientConfig: BedrockAgentClientConfig | undefined
  private readonly _knowledgeBaseId: string
  private readonly _dataSourceId: string | undefined
  private readonly _namespaceMetadataKey: string

  constructor(config: BedrockKnowledgeBaseStoreConfig) {
    this._runtimeClient = config.runtimeClient ?? new BedrockAgentRuntimeClient(config.runtimeClientConfig ?? {})
    this._agentClient = config.agentClient
    this._agentClientConfig = config.agentClientConfig
    this._knowledgeBaseId = config.knowledgeBaseId
    this._dataSourceId = config.dataSourceId
    this._namespaceMetadataKey = config.namespaceMetadataKey ?? 'namespace'
  }

  async search(namespace: string, query: string, limit?: number): Promise<KnowledgeEntry[]> {
    const filter: RetrievalFilter = {
      equals: {
        key: this._namespaceMetadataKey,
        value: namespace,
      },
    }

    const response = await this._runtimeClient.send(
      new RetrieveCommand({
        knowledgeBaseId: this._knowledgeBaseId,
        retrievalQuery: { text: query },
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: limit ?? 10,
            filter,
          },
        },
      })
    )

    return (response.retrievalResults ?? []).map((result, index) => {
      const metadata: Record<string, JSONValue> = {}
      if (result.metadata) {
        for (const [key, value] of Object.entries(result.metadata)) {
          metadata[key] = value as JSONValue
        }
      }
      if (result.location) {
        metadata._location = result.location as unknown as JSONValue
      }

      const entry: KnowledgeEntry = {
        id: this._resolveId(result.location?.customDocumentLocation?.id, result.metadata, index),
        content: result.content?.text ?? '',
        namespace,
        metadata,
      }
      if (result.score != null) {
        entry.score = result.score
      }
      return entry
    })
  }

  async store(namespace: string, content: string, metadata?: Record<string, JSONValue>): Promise<string> {
    const dataSourceId = this._requireDataSourceId()
    const id = uuidv7()

    const inlineAttributes: Array<{
      key: string
      value:
        | { type: 'STRING'; stringValue: string }
        | { type: 'NUMBER'; numberValue: number }
        | { type: 'BOOLEAN'; booleanValue: boolean }
    }> = [
      {
        key: this._namespaceMetadataKey,
        value: { type: 'STRING' as const, stringValue: namespace },
      },
    ]

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

    return id
  }

  async delete(namespace: string, id: string): Promise<void> {
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
          'Provide it in the config to enable store() and delete().'
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
