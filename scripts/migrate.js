import 'dotenv/config';
import { createDatabase } from '../src/db.js';
import { loadDatabaseConfig } from '../src/config.js';
import { migrateDatabase } from '../src/migrations.js';

const config = loadDatabaseConfig();
const pool = createDatabase(config);

try {
  await migrateDatabase(pool);
  console.info('Newsletter schema migration completed.');
} catch (error) {
  console.error('Newsletter schema migration failed.', {
    code: error?.code ?? 'UNKNOWN',
  });
  process.exitCode = 1;
} finally {
  await pool.end();
}
