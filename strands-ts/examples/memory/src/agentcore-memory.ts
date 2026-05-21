/**
 * AgentCore Memory integration example.
 *
 * Demonstrates how to build a custom KnowledgeStore adapter wrapping
 * the AgentCore Memory service, with namespace-scoped stores and the hybrid
 * pattern: auto-injection provides baseline context on every turn, while the
 * search_memory tool enables deeper on-demand retrieval.
 *
 * Environment variables:
 *   MEMORY_ID - The AgentCore Memory resource ID (required)
 *   ACTOR_ID  - The actor ID for event attribution (required)
 *   SESSION_ID - Optional session ID for event grouping
 *
 * Run: npm run start:agentcore-memory
 */
import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  RetrieveMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore'
import { Agent, BedrockModel, MemoryManager } from '@strands-agents/sdk'
import type { KnowledgeStore, KnowledgeEntry } from '@strands-agents/sdk'

// ─── AgentCoreMemoryStore (custom KnowledgeStore) ────────────────────────────

export interface AgentCoreMemoryStoreConfig {
  memoryId: string
  actorId: string
  namespace: string
  sessionId?: string
  topK?: number
  memoryStrategyId?: string
  client?: BedrockAgentCoreClient
}

export class AgentCoreMemoryStore implements KnowledgeStore {
  private readonly client: BedrockAgentCoreClient
  private readonly memoryId: string
  private readonly actorId: string
  private readonly namespace: string
  private readonly sessionId?: string
  private readonly topK: number
  private readonly memoryStrategyId?: string

  constructor(config: AgentCoreMemoryStoreConfig) {
    this.client = config.client ?? new BedrockAgentCoreClient()
    this.memoryId = config.memoryId
    this.actorId = config.actorId
    this.namespace = config.namespace
    this.sessionId = config.sessionId
    this.topK = config.topK ?? 10
    this.memoryStrategyId = config.memoryStrategyId
  }

  async search(query: string, options?: Record<string, unknown>): Promise<KnowledgeEntry[]> {
    const limit = typeof options?.limit === 'number' ? options.limit : this.topK
    const strategyId = typeof options?.memoryStrategyId === 'string' ? options.memoryStrategyId : this.memoryStrategyId

    const response = await this.client.send(
      new RetrieveMemoryRecordsCommand({
        memoryId: this.memoryId,
        namespace: this.namespace,
        searchCriteria: {
          searchQuery: query,
          topK: limit,
          memoryStrategyId: strategyId,
        },
      }),
    )

    return (response.memoryRecordSummaries ?? []).map((record) => ({
      id: record.memoryRecordId!,
      content: record.content?.text ?? '',
      metadata: {
        namespace: this.namespace,
        memoryStrategyId: record.memoryStrategyId,
        createdAt: record.createdAt?.toISOString(),
        score: record.score,
      },
    }))
  }

  async add(content: string, metadata?: Record<string, unknown>): Promise<void> {
    const metadataMap = metadata
      ? Object.fromEntries(
          Object.entries(metadata)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => [k, { stringValue: String(v) }]),
        )
      : undefined

    await this.client.send(
      new CreateEventCommand({
        memoryId: this.memoryId,
        actorId: this.actorId,
        sessionId: this.sessionId,
        eventTimestamp: new Date(),
        payload: [{ conversational: { content: { text: content }, role: 'ASSISTANT' } }],
        metadata: metadataMap,
      }),
    )
  }
}

// ─── Main Example ───────────────────────────────────────────────────────────────

async function main() {
  const memoryId = process.env.MEMORY_ID
  const actorId = process.env.ACTOR_ID

  if (!memoryId) {
    console.error('Error: MEMORY_ID environment variable is required.')
    console.error('Usage: MEMORY_ID=<id> ACTOR_ID=<id> npm run start:agentcore-memory')
    process.exit(1)
  }
  if (!actorId) {
    console.error('Error: ACTOR_ID environment variable is required.')
    console.error('Usage: MEMORY_ID=<id> ACTOR_ID=<id> npm run start:agentcore-memory')
    process.exit(1)
  }

  const sessionId = process.env.SESSION_ID ?? `session-${Date.now()}`
  const client = new BedrockAgentCoreClient()
  const model = new BedrockModel()

  const factsStore = new AgentCoreMemoryStore({
    client,
    memoryId,
    actorId,
    sessionId,
    namespace: `facts/${actorId}`,
    topK: 5,
  })

  const preferencesStore = new AgentCoreMemoryStore({
    client,
    memoryId,
    actorId,
    sessionId,
    namespace: `preferences/${actorId}`,
    topK: 3,
  })

  const memoryManager = new MemoryManager({
    stores: [
      {
        store: factsStore,
        limit: 5,
        ingestion: { trigger: 'perTurn' },
      },
      {
        store: preferencesStore,
        limit: 3,
        ingestion: { trigger: 'tool' },
      },
    ],
    tools: { search: true, store: true },
    injection: {
      format: (entries) => {
        const factEntries = entries.filter((e) => e.metadata?.namespace === `facts/${actorId}`)
        const prefEntries = entries.filter((e) => e.metadata?.namespace === `preferences/${actorId}`)
        const sections: string[] = []
        if (factEntries.length > 0) {
          sections.push(`[facts]\n${factEntries.map((e) => `- ${e.content}`).join('\n')}`)
        }
        if (prefEntries.length > 0) {
          sections.push(`[preferences]\n${prefEntries.map((e) => `- ${e.content}`).join('\n')}`)
        }
        if (sections.length === 0) return ''
        return `<agentcore_memory>\nThe following are relevant memories about the user:\n\n${sections.join('\n\n')}\n</agentcore_memory>`
      },
    },
  })

  const agent = new Agent({
    model,
    memoryManager,
    systemPrompt: [
      'You are a helpful assistant with long-term memory powered by AgentCore Memory.',
      'Relevant memories are automatically provided in your context each turn.',
      'You also have access to search_memory for deeper recall and store_memory to save preferences.',
      'Use store_memory to explicitly save user preferences when they share them.',
      'Use search_memory when you need to recall specific details not in your automatic context.',
    ].join('\n'),
  })

  console.log('=== AgentCore Memory Integration Example ===')
  console.log(`Memory ID: ${memoryId}`)
  console.log(`Actor ID: ${actorId}`)
  console.log(`Session ID: ${sessionId}`)
  console.log(`Namespaces: facts/${actorId}, preferences/${actorId}\n`)

  // Turn 1: User shares personal info + preferences
  console.log('--- Turn 1: User shares info (perTurn extracts facts, tool stores preferences) ---')
  console.log('User: My name is Jordan. I work at Acme Corp as a senior engineer. I prefer concise responses.\n')
  await agent.invoke(
    'My name is Jordan. I work at Acme Corp as a senior engineer. I prefer concise responses under 3 paragraphs. Please remember my preference.',
  )

  // Turn 2: New topic — auto-injection provides context
  console.log('\n--- Turn 2: Auto-injection recalls context for a new topic ---')
  console.log('User: Can you help me write a status update for my team?\n')
  await agent.invoke('Can you help me write a status update for my team?')

  // Turn 3: Explicit search for a specific preference
  console.log('\n--- Turn 3: Agent uses search_memory for specific recall ---')
  console.log('User: How do I like my responses formatted?\n')
  await agent.invoke('How do I like my responses formatted? Check your memory.')

  // Programmatic verification
  console.log('\n--- Programmatic verification ---')
  const factsResults = await factsStore.search('Jordan engineer Acme')
  console.log(`\nFacts store (facts/${actorId}): ${factsResults.length} entries`)
  for (const entry of factsResults) {
    console.log(`  [${entry.id}] ${entry.content} (score: ${entry.metadata?.score})`)
  }

  const prefResults = await preferencesStore.search('concise responses')
  console.log(`\nPreferences store (preferences/${actorId}): ${prefResults.length} entries`)
  for (const entry of prefResults) {
    console.log(`  [${entry.id}] ${entry.content} (score: ${entry.metadata?.score})`)
  }

  console.log('\n=== Done ===')
}

await main().catch(console.error)
