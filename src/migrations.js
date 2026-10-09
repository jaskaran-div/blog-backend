import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function migrateDatabase(pool) {
  const migrationPath = new URL('../sql/schema.sql', import.meta.url);
  const migration = await readFile(fileURLToPath(migrationPath), 'utf8');
  const statements = migration
    .split(/;\s*/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await pool.query(statement);
  }
}
