import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../src/db.js';
import { loadDatabaseConfig } from '../src/config.js';

const config = loadDatabaseConfig();
const pool = createDatabase(config);

try {
  const migrationPath = new URL('../sql/schema.sql', import.meta.url);
  const migration = await readFile(fileURLToPath(migrationPath), 'utf8');
  await pool.query(migration);
  console.info('Newsletter schema migration completed.');
} catch (error) {
  console.error('Newsletter schema migration failed.', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
