import type { MessageData } from '../../types/messages.js'
import type { JSONValue } from '../../types/json.js'

export interface ExtractedKnowledge {
  content: string
  metadata?: Record<string, JSONValue>
}

export interface Extractor {
  extract(messages: MessageData[]): Promise<ExtractedKnowledge[]>
}
