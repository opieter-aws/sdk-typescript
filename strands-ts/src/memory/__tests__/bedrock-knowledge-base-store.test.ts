import { describe, expect, it, vi, beforeEach } from 'vitest'
import { BedrockKnowledgeBaseStore } from '../bedrock-knowledge-base-store.js'

const mockRuntimeSend = vi.fn()
const mockAgentSend = vi.fn()

vi.mock('@aws-sdk/client-bedrock-agent-runtime', () => ({
  BedrockAgentRuntimeClient: class {
    send = mockRuntimeSend
  },
  RetrieveCommand: class {
    constructor(public readonly input: unknown) {}
  },
}))

vi.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class {
    send = mockAgentSend
  },
  IngestKnowledgeBaseDocumentsCommand: class {
    constructor(public readonly input: unknown) {}
  },
  DeleteKnowledgeBaseDocumentsCommand: class {
    constructor(public readonly input: unknown) {}
  },
}))

vi.mock('uuid', () => ({
  v7: () => 'mock-uuid-v7',
}))

describe('BedrockKnowledgeBaseStore', () => {
  let store: BedrockKnowledgeBaseStore

  beforeEach(() => {
    vi.clearAllMocks()
    store = new BedrockKnowledgeBaseStore({
      knowledgeBaseId: 'kb-123',
      dataSourceId: 'ds-456',
      scope: 'user-abc',
    })
  })

  describe('search', () => {
    it('should call Retrieve API with scope filter and limit from options', async () => {
      mockRuntimeSend.mockResolvedValue({ retrievalResults: [] })

      await store.search('what is the refund policy', { limit: 5 })

      const command = mockRuntimeSend.mock.calls[0]![0]
      expect(command.input).toEqual({
        knowledgeBaseId: 'kb-123',
        retrievalQuery: { text: 'what is the refund policy' },
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: 5,
            filter: {
              equals: { key: 'namespace', value: 'user-abc' },
            },
          },
        },
      })
    })

    it('should use custom scopeMetadataKey', async () => {
      const customStore = new BedrockKnowledgeBaseStore({
        knowledgeBaseId: 'kb-456',
        scope: 'tenant-xyz',
        scopeMetadataKey: 'tenant_id',
      })
      mockRuntimeSend.mockResolvedValue({ retrievalResults: [] })

      await customStore.search('query')

      const command = mockRuntimeSend.mock.calls[0]![0]
      expect(command.input.retrievalConfiguration.vectorSearchConfiguration.filter).toEqual({
        equals: { key: 'tenant_id', value: 'tenant-xyz' },
      })
    })

    it('should not include filter when no scope is configured', async () => {
      const noScopeStore = new BedrockKnowledgeBaseStore({
        knowledgeBaseId: 'kb-789',
      })
      mockRuntimeSend.mockResolvedValue({ retrievalResults: [] })

      await noScopeStore.search('query')

      const command = mockRuntimeSend.mock.calls[0]![0]
      expect(command.input.retrievalConfiguration.vectorSearchConfiguration.filter).toBeUndefined()
    })

    it('should map results to KnowledgeEntry format with score in metadata', async () => {
      mockRuntimeSend.mockResolvedValue({
        retrievalResults: [
          {
            content: { text: 'Refunds take 5-7 business days.' },
            score: 0.92,
            metadata: { category: 'policy', namespace: 'user-abc' },
            location: {
              type: 'CUSTOM',
              customDocumentLocation: { id: 'doc-001' },
            },
          },
          {
            content: { text: 'Contact support for refund requests.' },
            score: 0.85,
            metadata: { category: 'support' },
            location: {
              type: 'S3',
              s3Location: { uri: 's3://bucket/support.pdf' },
            },
          },
        ],
      })

      const results = await store.search('refund')

      expect(results).toHaveLength(2)
      expect(results[0]).toEqual({
        id: 'doc-001',
        content: 'Refunds take 5-7 business days.',
        metadata: {
          category: 'policy',
          namespace: 'user-abc',
          _location: { type: 'CUSTOM', customDocumentLocation: { id: 'doc-001' } },
          score: 0.92,
        },
      })
      expect(results[1]).toEqual({
        id: 'result-1',
        content: 'Contact support for refund requests.',
        metadata: {
          category: 'support',
          _location: { type: 'S3', s3Location: { uri: 's3://bucket/support.pdf' } },
          score: 0.85,
        },
      })
    })

    it('should use metadata id field when customDocumentLocation is unavailable', async () => {
      mockRuntimeSend.mockResolvedValue({
        retrievalResults: [
          {
            content: { text: 'Some text' },
            score: 0.8,
            metadata: { id: 'meta-id-123' },
            location: { type: 'S3', s3Location: { uri: 's3://bucket/file.txt' } },
          },
        ],
      })

      const results = await store.search('query')
      expect(results[0]!.id).toBe('meta-id-123')
    })

    it('should fall back to index-based id when no id is available', async () => {
      mockRuntimeSend.mockResolvedValue({
        retrievalResults: [
          {
            content: { text: 'No id available' },
            score: 0.7,
            metadata: {},
          },
        ],
      })

      const results = await store.search('query')
      expect(results[0]!.id).toBe('result-0')
    })

    it('should default limit to 10 when not specified', async () => {
      mockRuntimeSend.mockResolvedValue({ retrievalResults: [] })

      await store.search('query')

      const command = mockRuntimeSend.mock.calls[0]![0]
      expect(command.input.retrievalConfiguration.vectorSearchConfiguration.numberOfResults).toBe(10)
    })

    it('should handle empty retrievalResults', async () => {
      mockRuntimeSend.mockResolvedValue({ retrievalResults: undefined })

      const results = await store.search('query')
      expect(results).toEqual([])
    })

    it('should accept a pre-built runtime client', async () => {
      const customClient = { send: vi.fn().mockResolvedValue({ retrievalResults: [] }) }
      const storeWithClient = new BedrockKnowledgeBaseStore({
        knowledgeBaseId: 'kb-789',
        runtimeClient: customClient as any,
      })

      await storeWithClient.search('test')
      expect(customClient.send).toHaveBeenCalledOnce()
    })
  })

  describe('add', () => {
    it('should call IngestKnowledgeBaseDocuments with inline text and scope', async () => {
      mockAgentSend.mockResolvedValue({ documentDetails: [] })

      await store.add('User prefers dark mode')

      const command = mockAgentSend.mock.calls[0]![0]
      expect(command.input).toEqual({
        knowledgeBaseId: 'kb-123',
        dataSourceId: 'ds-456',
        documents: [
          {
            content: {
              dataSourceType: 'CUSTOM',
              custom: {
                customDocumentIdentifier: { id: 'mock-uuid-v7' },
                sourceType: 'IN_LINE',
                inlineContent: {
                  type: 'TEXT',
                  textContent: { data: 'User prefers dark mode' },
                },
              },
            },
            metadata: {
              type: 'IN_LINE_ATTRIBUTE',
              inlineAttributes: [{ key: 'namespace', value: { type: 'STRING', stringValue: 'user-abc' } }],
            },
          },
        ],
      })
    })

    it('should include metadata as inline attributes', async () => {
      mockAgentSend.mockResolvedValue({ documentDetails: [] })

      await store.add('A fact', { category: 'preferences', _source: 'tool' })

      const command = mockAgentSend.mock.calls[0]![0]
      const attrs = command.input.documents[0].metadata.inlineAttributes
      expect(attrs).toContainEqual({ key: 'namespace', value: { type: 'STRING', stringValue: 'user-abc' } })
      expect(attrs).toContainEqual({ key: 'category', value: { type: 'STRING', stringValue: 'preferences' } })
      expect(attrs).toContainEqual({ key: '_source', value: { type: 'STRING', stringValue: 'tool' } })
    })

    it('should not include scope attribute when no scope configured', async () => {
      const noScopeStore = new BedrockKnowledgeBaseStore({
        knowledgeBaseId: 'kb-123',
        dataSourceId: 'ds-456',
      })
      mockAgentSend.mockResolvedValue({ documentDetails: [] })

      await noScopeStore.add('A fact', { category: 'test' })

      const command = mockAgentSend.mock.calls[0]![0]
      const attrs = command.input.documents[0].metadata.inlineAttributes
      expect(attrs).not.toContainEqual(expect.objectContaining({ key: 'namespace' }))
      expect(attrs).toContainEqual({ key: 'category', value: { type: 'STRING', stringValue: 'test' } })
    })

    it('should throw if dataSourceId is not configured', async () => {
      const readOnlyStore = new BedrockKnowledgeBaseStore({
        knowledgeBaseId: 'kb-123',
      })

      await expect(readOnlyStore.add('content')).rejects.toThrow('dataSourceId is required for write operations')
    })
  })

  describe('delete', () => {
    it('should call DeleteKnowledgeBaseDocuments with custom document id', async () => {
      mockAgentSend.mockResolvedValue({ documentDetails: [] })

      await store.delete('doc-789')

      const command = mockAgentSend.mock.calls[0]![0]
      expect(command.input).toEqual({
        knowledgeBaseId: 'kb-123',
        dataSourceId: 'ds-456',
        documentIdentifiers: [
          {
            dataSourceType: 'CUSTOM',
            custom: { id: 'doc-789' },
          },
        ],
      })
    })

    it('should throw if dataSourceId is not configured', async () => {
      const readOnlyStore = new BedrockKnowledgeBaseStore({
        knowledgeBaseId: 'kb-123',
      })

      await expect(readOnlyStore.delete('id')).rejects.toThrow('dataSourceId is required for write operations')
    })
  })
})
