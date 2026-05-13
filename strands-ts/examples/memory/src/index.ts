/**
 * MemoryManager E2E example.
 *
 * Demonstrates:
 * 1. Agent with FileKnowledgeStore for persistent memory
 * 2. search_memory / store_memory tools available to the agent
 * 3. Multi-turn conversation where the agent stores and retrieves facts
 *
 * Run: npm start
 */
import { Agent, BedrockModel, FileKnowledgeStore, MemoryManager } from '@strands-agents/sdk'
import * as path from 'node:path'

async function main() {
  const model = new BedrockModel()

  // File-based store persists across runs
  const knowledgeStore = new FileKnowledgeStore({
    baseDir: path.join(process.cwd(), '.memory-store'),
  })

  const memoryManager = new MemoryManager({
    stores: [
      {
        store: knowledgeStore,
        namespace: 'user-preferences',
        limit: 5,
        ingestion: { trigger: 'tool' },
      },
    ],
  })

  const agent = new Agent({
    model,
    memoryManager,
    systemPrompt: [
      'You are a helpful assistant with long-term memory.',
      'Use search_memory to recall facts from past conversations.',
      'Use store_memory to save important facts about the user for later.',
      'Always check memory before answering questions about the user.',
    ].join('\n'),
  })

  console.log('=== Memory Manager E2E Test ===\n')

  // Turn 1: Tell the agent some facts
  console.log('--- Turn 1: Storing user preferences ---')
  console.log('User: My name is Alex. I prefer dark mode and I work at a startup in Austin, TX.\n')
  await agent.invoke(
    'My name is Alex. I prefer dark mode and I work at a startup in Austin, TX. Please remember these facts.',
  )

  // Turn 2: Ask the agent to recall
  console.log('\n--- Turn 2: Recalling from memory ---')
  console.log('User: What do you know about me?\n')
  await agent.invoke('What do you know about me? Search your memory.')

  // Turn 3: Verify persistence — search the store directly
  console.log('\n--- Direct store search (no agent) ---')
  const results = await knowledgeStore.search('user-preferences', 'dark mode')
  console.log(`Found ${results.length} entries matching "dark mode":`)
  for (const entry of results) {
    console.log(`  [${entry.id}] ${entry.content} (score: ${entry.score})`)
    if (entry.metadata) console.log(`    metadata: ${JSON.stringify(entry.metadata)}`)
  }

  console.log('\n=== Done ===')
}

await main().catch(console.error)
