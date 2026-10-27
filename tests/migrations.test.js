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
  assert.match(schema, /CREATE TABLE IF NOT EXISTS market_snapshots/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS market_snapshot_runs/);
  assert.match(schema, /TIMESTAMPTZ/);
  assert.match(schema, /gen_random_uuid/);
  assert.doesNotMatch(schema, /ENGINE=InnoDB|AUTO_INCREMENT/);
});

test('market snapshot migration is additive and leaves newsletter data untouched', async () => {
  let schema;
  await migrateDatabase({ async query(statement) { schema = statement; } });
  const marketSection = schema.slice(schema.indexOf('-- Market data snapshots'));

  assert.ok(marketSection.length > 0 && marketSection !== schema);
  assert.doesNotMatch(marketSection, /\b(DROP|DELETE|TRUNCATE|ALTER)\b/i);
  assert.doesNotMatch(marketSection, /subscribers|newsletters|newsletter_deliveries/);
  assert.doesNotMatch(schema, /DROP TABLE/i);
});

test('automated news migration is additive, deduplicates Gmail messages and leaves other tables alone', async () => {
  let schema;
  await migrateDatabase({ async query(statement) { schema = statement; } });
  const autoNewsSection = schema.slice(schema.indexOf('-- Automated News & Insights posts'));

  assert.ok(autoNewsSection.length > 0 && autoNewsSection !== schema);
  assert.match(autoNewsSection, /CREATE TABLE IF NOT EXISTS automated_news_posts/);
  assert.match(autoNewsSection, /CONSTRAINT automated_news_posts_gmail_message_id_key UNIQUE \(gmail_message_id\)/);
  assert.match(autoNewsSection, /CONSTRAINT automated_news_posts_slug_key UNIQUE \(slug\)/);
  assert.match(autoNewsSection, /status IN \('draft', 'published', 'failed', 'rejected'\)/);
  assert.match(autoNewsSection, /CREATE INDEX IF NOT EXISTS automated_news_posts_published_idx/);
  assert.doesNotMatch(autoNewsSection, /\b(DROP|DELETE|TRUNCATE|ALTER|UPDATE)\b/i);
  assert.doesNotMatch(schema, /newsletter_articles/);
});
