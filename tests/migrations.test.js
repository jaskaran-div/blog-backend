import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateDatabase } from '../src/migrations.js';

test('migration applies all MySQL newsletter tables without PostgreSQL statements', async () => {
  const statements = [];
  await migrateDatabase({
    async query(statement) {
      statements.push(statement);
    },
  });

  assert.equal(statements.length, 3);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS subscribers/);
  assert.match(statements[1], /CREATE TABLE IF NOT EXISTS newsletters/);
  assert.match(statements[2], /CREATE TABLE IF NOT EXISTS newsletter_deliveries/);
  assert.ok(statements.every((statement) => !/public\.|timestamptz|gen_random_uuid/.test(statement)));
});
