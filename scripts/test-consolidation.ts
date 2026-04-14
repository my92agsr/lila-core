import { initDatabase } from '../src/db.js'
import { runConsolidation } from '../src/consolidation.js'
import { logger } from '../src/logger.js'

async function main() {
  initDatabase()
  logger.info('Running consolidation test...')
  const result = await runConsolidation()
  console.log('\n=== Consolidation Result ===')
  console.log(JSON.stringify(result, null, 2))
}

main().catch(console.error).finally(() => process.exit(0))
