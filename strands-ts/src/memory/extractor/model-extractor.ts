import type { Model } from '../../models/model.js'
import type { Extractor, ExtractedKnowledge } from './types.js'
import type { JSONValue } from '../../types/json.js'
import type { MessageData } from '../../types/messages.js'
import { Message, TextBlock } from '../../types/messages.js'
import { logger } from '../../logging/logger.js'

const DEFAULT_SYSTEM_PROMPT = `You are a knowledge extraction assistant. Given a conversation, extract discrete facts worth remembering for future conversations.

Return a JSON array where each element has:
- "content": a concise factual statement
- "metadata" (optional): an object with optional fields "category", "source", "tags", "confidence"

Rules:
- Extract only facts that would be useful in future conversations (preferences, decisions, context)
- Do NOT extract transient information (greetings, filler, task-specific details unlikely to recur)
- Each fact should be self-contained and understandable without surrounding context
- Return an empty array [] if no facts are worth extracting
- Return ONLY the JSON array, no other text`

export interface ModelExtractorConfig {
  model: Model
  systemPrompt?: string
}

export class ModelExtractor implements Extractor {
  private readonly _model: Model
  private readonly _systemPrompt: string

  constructor(config: ModelExtractorConfig) {
    this._model = config.model
    this._systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  }

  async extract(messages: MessageData[]): Promise<ExtractedKnowledge[]> {
    if (messages.length === 0) return []

    const inputMessages = [
      ...messages.map((m) => Message.fromMessageData(m)),
      new Message({
        role: 'user',
        content: [new TextBlock('Extract facts from the conversation above as a JSON array.')],
      }),
    ]

    const stream = this._model.streamAggregated(inputMessages, {
      systemPrompt: this._systemPrompt,
    })

    let result: Awaited<ReturnType<typeof stream.next>> | undefined
    for (;;) {
      result = await stream.next()
      if (result.done) break
    }

    if (!result?.done || !result.value) {
      logger.warn('ModelExtractor: no response from model')
      return []
    }

    const responseText = result.value.message.content
      .filter((block): block is TextBlock => block instanceof TextBlock)
      .map((block) => block.text)
      .join('')

    return this._parseResponse(responseText)
  }

  private _parseResponse(text: string): ExtractedKnowledge[] {
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      logger.warn('ModelExtractor: no JSON array found in response')
      return []
    }

    try {
      const parsed: unknown = JSON.parse(jsonMatch[0])
      if (!Array.isArray(parsed)) return []

      return parsed
        .filter(
          (item): item is { content: string; metadata?: Record<string, unknown> } =>
            typeof item === 'object' && item !== null && typeof (item as { content?: unknown }).content === 'string'
        )
        .map((item) => {
          const result: ExtractedKnowledge = { content: item.content }
          if (item.metadata) {
            result.metadata = item.metadata as Record<string, JSONValue>
          }
          return result
        })
    } catch {
      logger.warn('ModelExtractor: failed to parse JSON response')
      return []
    }
  }
}
