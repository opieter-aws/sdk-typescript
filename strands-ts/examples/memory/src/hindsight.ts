/**
 * HindSight KnowledgeStore example.
 *
 * Demonstrates a custom KnowledgeStore implementation backed by HindSight
 * (https://github.com/vectorize-io/hindsight) — an AI memory platform with semantic,
 * keyword, graph, and temporal retrieval.
 *
 * Also showcases HindSight's unique "reflect" capability for synthesizing insights
 * across stored memories, exposed as an additional agent tool.
 *
 * Environment variables:
 *   HINDSIGHT_BANK_ID  - The HindSight memory bank ID (required)
 *   HINDSIGHT_BASE_URL - The HindSight server URL (defaults to http://localhost:8888)
 *
 * Run: npm run start:hindsight
 */
import { Agent, BedrockModel, MemoryManager, tool } from '@strands-agents/sdk'
import type { KnowledgeEntry, KnowledgeStore } from '@strands-agents/sdk'
import { HindsightClient } from '@vectorize-io/hindsight-client'
import { z } from 'zod'

// ─── Store Implementation ────────────────────────────────────────────────────

interface HindSightKnowledgeStoreConfig {
  baseUrl: string
  bankId: string
}

class HindSightKnowledgeStore implements KnowledgeStore {
  private readonly _client: HindsightClient
  private readonly _bankId: string

  constructor(config: HindSightKnowledgeStoreConfig) {
    this._client = new HindsightClient({ baseUrl: config.baseUrl })
    this._bankId = config.bankId
  }

  async search(query: string, options?: Record<string, unknown>): Promise<KnowledgeEntry[]> {
    const response = await this._client.recall(this._bankId, query)
    const limit = typeof options?.limit === 'number' ? options.limit : undefined

    let results: KnowledgeEntry[] = response.results.map((result, index) => {
      const metadata: Record<string, unknown> = { score: 1 / (index + 1) }
      if (result.type) metadata.type = result.type
      if (result.context) metadata.context = result.context
      if (result.entities) metadata.entities = result.entities

      return {
        id: result.id,
        content: result.text,
        metadata,
      }
    })

    if (limit) {
      results = results.slice(0, limit)
    }
    return results
  }

  async add(content: string, metadata?: Record<string, unknown>): Promise<void> {
    const documentId = crypto.randomUUID()

    await this._client.retain(this._bankId, content, {
      documentId,
      ...(metadata && { metadata: metadata as unknown as Record<string, string> }),
    })
  }

  async reflect(query: string): Promise<string> {
    const response = await this._client.reflect(this._bankId, query)
    return response.text
  }

  async addBatch(entries: Array<{ content: string; metadata?: Record<string, unknown> }>): Promise<void> {
    await Promise.all(entries.map((entry) => this.add(entry.content, entry.metadata)))
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const baseUrl = process.env.HINDSIGHT_BASE_URL ?? 'http://localhost:8888'
  const bankId = process.env.HINDSIGHT_BANK_ID

  if (!bankId) {
    console.error('Error: HINDSIGHT_BANK_ID environment variable is required.')
    console.error('Usage: HINDSIGHT_BANK_ID=<id> npm run start:hindsight')
    console.error('')
    console.error('Optional: HINDSIGHT_BASE_URL (defaults to http://localhost:8888)')
    process.exit(1)
  }

  const model = new BedrockModel()

  const knowledgeStore = new HindSightKnowledgeStore({ baseUrl, bankId })

  const memoryManager = new MemoryManager({
    stores: [
      {
        store: knowledgeStore,
        limit: 10,
        ingestion: { trigger: 'tool' },
      },
    ],
  })

  const reflectMemoryTool = tool({
    name: 'reflect_memory',
    description:
      'Analyze stored memories to synthesize deeper insights, identify patterns, ' +
      'or answer complex questions requiring reasoning across multiple memories. ' +
      'Use when the user asks for analysis, recommendations, or synthesis rather than simple fact recall.',
    inputSchema: z.object({
      query: z.string().describe('The analytical question to reflect on'),
    }),
    callback: async (input) => {
      return await knowledgeStore.reflect(input.query)
    },
  })

  const agent = new Agent({
    model,
    memoryManager,
    tools: [reflectMemoryTool],
    systemPrompt: [
      'You are a helpful assistant with long-term memory powered by HindSight.',
      'Use search_memory to recall specific facts from stored memories.',
      'Use store_memory to save important facts about the user for later.',
      'Use reflect_memory when the user asks for analysis, synthesis, or recommendations based on stored memories.',
      'HindSight uses semantic, keyword, graph, and temporal search — use natural language queries.',
    ].join('\n'),
  })

  console.log('=== HindSight KnowledgeStore Example ===')
  console.log(`Server: ${baseUrl}`)
  console.log(`Bank: ${bankId}\n`)

  // Turn 1: Store facts
  console.log('--- Turn 1: Storing facts ---')
  console.log('User: Remember that my colleague Alice got promoted to senior engineer and prefers async communication.\n')
  await agent.invoke(
    'Remember that my colleague Alice got promoted to senior engineer and she prefers async communication over meetings. Please store these facts.',
  )

  // Turn 2: Recall
  console.log('\n--- Turn 2: Recalling from memory ---')
  console.log('User: What do you know about Alice?\n')
  await agent.invoke('What do you know about Alice? Search your memory.')

  // Turn 3: Reflect (unique HindSight capability)
  console.log('\n--- Turn 3: Reflecting on memories ---')
  console.log('User: Based on what you know about Alice, how should I best collaborate with her?\n')
  await agent.invoke(
    'Based on everything you know about Alice, what communication style should I use when collaborating with her? Use reflect_memory to analyze.',
  )

  // Programmatic verification
  console.log('\n--- Programmatic verification ---')
  const results = await knowledgeStore.search('Alice communication')
  console.log(`Found ${results.length} entries matching "Alice communication":`)
  for (const entry of results) {
    console.log(`  [${entry.id}] ${entry.content} (score: ${(entry.metadata?.score as number)?.toFixed(2)})`)
    if (entry.metadata) console.log(`    metadata: ${JSON.stringify(entry.metadata)}`)
  }

  console.log('\n--- Direct reflect call ---')
  const insight = await knowledgeStore.reflect('What patterns do I see about Alice?')
  console.log(`Reflection: ${insight}`)

  console.log('\n=== Done ===')
}

await main().catch(console.error)
