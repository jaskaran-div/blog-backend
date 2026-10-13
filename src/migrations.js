import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function migrateDatabase(pool) {
  const migrationPath = new URL('../sql/schema.sql', import.meta.url);
  const migration = await readFile(fileURLToPath(migrationPath), 'utf8');
  await pool.query(migration);
}
