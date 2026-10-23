import 'dotenv/config';
import { createDatabase } from '../src/db.js';
import { loadDatabaseConfig, loadMarketSnapshotConfig } from '../src/config.js';
import { createMarketSnapshotService } from '../src/marketSnapshotService.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const config = { ...loadDatabaseConfig(), marketSnapshot: loadMarketSnapshotConfig() };
const pool = createDatabase(config);

try {
  if (args.some((argument) => argument !== '--force')) {
    throw new Error('Usage: npm run market:refresh [-- --force]');
  }
  const service = createMarketSnapshotService({ pool, config });
  const result = await service.refresh({ trigger: 'manual', force });
  console.info('Market snapshot refresh result', result);
  if (result.reason === 'recent-run') {
    console.info('A refresh started within MARKET_SNAPSHOT_MIN_INTERVAL_MINUTES; rerun with -- --force to refresh anyway.');
  }
  if (result.status !== 'succeeded') {
    process.exitCode = 1;
  }
} catch (error) {
  console.error('Market snapshot refresh failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
