/**
 * InMemoryKnowledgeStore example.
 *
 * Demonstrates ephemeral memory that lives only for the process lifetime.
 * Useful for testing, short-lived sessions, or when persistence isn't needed.
 *
 * Run: npm run start:in-memory
 */
import { Agent, BedrockModel, InMemoryKnowledgeStore, MemoryManager } from '@strands-agents/sdk'

async function main() {
  const model = new BedrockModel()

  const knowledgeStore = new InMemoryKnowledgeStore()

  const memoryManager = new MemoryManager({
    stores: [
      {
        store: knowledgeStore,
        limit: 10,
        ingestion: { trigger: 'tool' },
      },
    ],
  })

  const agent = new Agent({
    model,
    memoryManager,
    systemPrompt: [
      'You are a helpful assistant with session memory.',
      'Use search_memory to recall facts stored earlier in this session.',
      'Use store_memory to save important facts for later recall.',
      'When searching memory, include all relevant keywords in a single query (e.g. "name dark mode Austin") — the search matches any of the words. When storing, pass all facts in a single store_memory call.',
    ].join('\n'),
  })

  console.log('=== InMemoryKnowledgeStore Example ===\n')

  // Turn 1: Store facts
  console.log('--- Turn 1: Storing facts ---')
  console.log('User: Remember that my favorite language is TypeScript and I use Neovim.\n')
  await agent.invoke('Remember that my favorite language is TypeScript and I use Neovim.')

  // Turn 2: Recall
  console.log('\n--- Turn 2: Recalling ---')
  console.log('User: What editor and language do I use?\n')
  await agent.invoke('What editor and language do I use? Search your memory.')

  // Turn 3: Verify programmatically
  console.log('\n--- Programmatic verification ---')
  const results = await knowledgeStore.search('TypeScript Neovim')
  console.log(`Found ${results.length} entries matching "TypeScript Neovim":`)
  for (const entry of results) {
    console.log(`  [${entry.id}] ${entry.content} (score: ${entry.metadata?.score})`)
  }

  console.log('\n=== Done ===')
}

await main().catch(console.error)
