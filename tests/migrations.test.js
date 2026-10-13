import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateDatabase } from '../src/migrations.js';

test('migration applies the PostgreSQL newsletter schema', async () => {
  let schema;
  await migrateDatabase({
    async query(statement) {
      schema = statement;
    },
  });

  assert.match(schema, /CREATE TABLE IF NOT EXISTS subscribers/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS newsletters/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS newsletter_deliveries/);
  assert.match(schema, /TIMESTAMPTZ/);
  assert.match(schema, /gen_random_uuid/);
  assert.doesNotMatch(schema, /ENGINE=InnoDB|AUTO_INCREMENT/);
});
