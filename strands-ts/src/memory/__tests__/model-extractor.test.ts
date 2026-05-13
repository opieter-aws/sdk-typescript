import { describe, expect, it, vi } from 'vitest'
import { ModelExtractor } from '../extractor/model-extractor.js'
import type { Model } from '../../models/model.js'
import { Message, TextBlock } from '../../types/messages.js'
import type { MessageData } from '../../types/messages.js'

function createMockModel(responseText: string): Model {
  const message = new Message({
    role: 'assistant',
    content: [new TextBlock(responseText)],
  })

  const mockStreamAggregated = async function* () {
    yield
    return { message, stopReason: 'end_turn' as const, metadata: undefined, redaction: undefined }
  }

  return {
    streamAggregated: vi.fn().mockImplementation(mockStreamAggregated),
  } as unknown as Model
}

function createFailingModel(): Model {
  const mockStreamAggregated = async function* () {
    yield
    return undefined
  }

  return {
    streamAggregated: vi.fn().mockImplementation(mockStreamAggregated),
  } as unknown as Model
}

describe('ModelExtractor', () => {
  const sampleMessages: MessageData[] = [
    { role: 'user', content: [{ text: 'I prefer dark mode and live in Seattle' }] },
    { role: 'assistant', content: [{ text: 'Noted! I will remember your preferences.' }] },
  ]

  it('should extract facts from model response', async () => {
    const model = createMockModel(
      JSON.stringify([
        { content: 'User prefers dark mode', metadata: { category: 'preferences' } },
        { content: 'User lives in Seattle', metadata: { category: 'personal', tags: ['location'] } },
      ])
    )

    const extractor = new ModelExtractor({ model })
    const results = await extractor.extract(sampleMessages)

    expect(results).toHaveLength(2)
    expect(results[0]!.content).toBe('User prefers dark mode')
    expect(results[0]!.metadata?.category).toBe('preferences')
    expect(results[1]!.content).toBe('User lives in Seattle')
    expect(results[1]!.metadata?.tags).toEqual(['location'])
  })

  it('should handle JSON wrapped in markdown code block', async () => {
    const model = createMockModel('```json\n[{"content": "User likes TypeScript"}]\n```')

    const extractor = new ModelExtractor({ model })
    const results = await extractor.extract(sampleMessages)

    expect(results).toHaveLength(1)
    expect(results[0]!.content).toBe('User likes TypeScript')
  })

  it('should return empty array for empty messages', async () => {
    const model = createMockModel('[]')
    const extractor = new ModelExtractor({ model })
    const results = await extractor.extract([])

    expect(results).toHaveLength(0)
    expect(model.streamAggregated).not.toHaveBeenCalled()
  })

  it('should return empty array on invalid JSON response', async () => {
    const model = createMockModel('This is not JSON at all')
    const extractor = new ModelExtractor({ model })
    const results = await extractor.extract(sampleMessages)

    expect(results).toHaveLength(0)
  })

  it('should return empty array when model returns no response', async () => {
    const model = createFailingModel()
    const extractor = new ModelExtractor({ model })
    const results = await extractor.extract(sampleMessages)

    expect(results).toHaveLength(0)
  })

  it('should filter out items without content field', async () => {
    const model = createMockModel(
      JSON.stringify([
        { content: 'Valid fact' },
        { notContent: 'Invalid item' },
        { content: 123 },
        { content: 'Another valid fact' },
      ])
    )

    const extractor = new ModelExtractor({ model })
    const results = await extractor.extract(sampleMessages)

    expect(results).toHaveLength(2)
    expect(results[0]!.content).toBe('Valid fact')
    expect(results[1]!.content).toBe('Another valid fact')
  })

  it('should use custom system prompt when provided', async () => {
    const model = createMockModel('[{"content": "custom extraction"}]')
    const customPrompt = 'Extract only names mentioned.'

    const extractor = new ModelExtractor({ model, systemPrompt: customPrompt })
    await extractor.extract(sampleMessages)

    expect(model.streamAggregated).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ systemPrompt: customPrompt })
    )
  })
})
