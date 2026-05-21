/**
 * BedrockKnowledgeBaseStore example.
 *
 * Demonstrates memory backed by Amazon Bedrock Knowledge Bases with vector search.
 * Requires a Bedrock Knowledge Base and data source to be set up.
 *
 * Environment variables:
 *   KNOWLEDGE_BASE_ID - The Bedrock Knowledge Base ID
 *   DATA_SOURCE_ID    - The data source ID (required for store/delete)
 *
 * Run: npm run start:bedrock-kb
 */
import { Agent, BedrockModel, BedrockKnowledgeBaseStore, MemoryManager } from '@strands-agents/sdk'

async function main() {
  const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID
  const dataSourceId = process.env.DATA_SOURCE_ID

  if (!knowledgeBaseId) {
    console.error('Error: KNOWLEDGE_BASE_ID environment variable is required.')
    console.error('Usage: KNOWLEDGE_BASE_ID=<id> DATA_SOURCE_ID=<id> npm run start:bedrock-kb')
    process.exit(1)
  }

  if (!dataSourceId) {
    console.error('Error: DATA_SOURCE_ID environment variable is required for write operations.')
    console.error('Usage: KNOWLEDGE_BASE_ID=<id> DATA_SOURCE_ID=<id> npm run start:bedrock-kb')
    process.exit(1)
  }

  const model = new BedrockModel()

  const knowledgeStore = new BedrockKnowledgeBaseStore({
    knowledgeBaseId,
    dataSourceId,
    scope: 'user-memory',
  })

  const memoryManager = new MemoryManager({
    stores: [
      {
        store: knowledgeStore,
        limit: 5,
        ingestion: { trigger: 'tool' },
      },
    ],
  })

  const agent = new Agent({
    model,
    memoryManager,
    systemPrompt: [
      'You are a helpful assistant with long-term memory backed by a knowledge base.',
      'Use search_memory to recall facts from past conversations.',
      'Use store_memory to save important facts about the user for later.',
      'When searching memory, use natural language queries — the knowledge base uses semantic vector search. When storing, pass all facts in a single store_memory call.',
    ].join('\n'),
  })

  console.log('=== BedrockKnowledgeBaseStore Example ===')
  console.log(`Knowledge Base: ${knowledgeBaseId}`)
  console.log(`Data Source: ${dataSourceId}\n`)

  // Turn 1: Store facts
  console.log('--- Turn 1: Storing user preferences ---')
  console.log('User: My name is Alex. I prefer dark mode and I work at a startup in Austin, TX.\n')
  await agent.invoke(
    'My name is Alex. I prefer dark mode and I work at a startup in Austin, TX. Please remember these facts.',
  )

  // Turn 2: Recall (vector search handles semantic matching)
  console.log('\n--- Turn 2: Recalling from knowledge base ---')
  console.log('User: What do you know about me?\n')
  await agent.invoke('What do you know about me? Search your memory.')

  // Turn 3: Verify programmatically
  console.log('\n--- Programmatic verification ---')
  const results = await knowledgeStore.search('user preferences and personal info')
  console.log(`Found ${results.length} entries:`)
  for (const entry of results) {
    console.log(`  [${entry.id}] ${entry.content} (score: ${entry.metadata?.score})`)
    if (entry.metadata) console.log(`    metadata: ${JSON.stringify(entry.metadata)}`)
  }

  console.log('\n=== Done ===')
}

await main().catch(console.error)
