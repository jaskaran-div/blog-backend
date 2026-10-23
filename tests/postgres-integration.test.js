import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDatabase } from '../src/db.js';
import { loadDatabaseConfig } from '../src/config.js';
import { migrateDatabase } from '../src/migrations.js';
import { createMarketSnapshotService } from '../src/marketSnapshotService.js';
import { createNewsletterService } from '../src/newsletterService.js';
import { createUnsubscribeToken } from '../src/tokens.js';

const integrationEnabled = process.env.POSTGRES_INTEGRATION_TEST === '1';
const config = {
  apiPublicUrl: 'https://newsletter.integration.test',
  tokenSecret: 'postgres-integration-token-secret-with-more-than-32-bytes',
  batchSize: 10,
  sendConcurrency: 2,
  staleSendMinutes: 1,
};

test('PostgreSQL migration, subscription lifecycle, concurrent claims, delivery and retries', {
  skip: !integrationEnabled,
}, async () => {
  const pool = createDatabase(loadDatabaseConfig());
  const subscriberIds = [];
  const newsletterId = randomUUID();
  let schemaReady = false;
  let releaseEmailHold;

  try {
    await migrateDatabase(pool);
    await migrateDatabase(pool);
    schemaReady = true;

    const { rows: tables } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = ANY($1::text[])`,
      [['subscribers', 'newsletters', 'newsletter_deliveries']],
    );
    assert.deepEqual(new Set(tables.map((table) => table.table_name)), new Set([
      'subscribers',
      'newsletters',
      'newsletter_deliveries',
    ]));

    const service = createNewsletterService({
      pool,
      emailService: { async sendEmail() {} },
      config,
      logger: { info() {}, error() {} },
    });
    const activeEmail = `reader-${randomUUID()}@example.test`;
    await service.subscribe(`  ${activeEmail.toUpperCase()}  `);
    const { rows: activeRows } = await pool.query(
      'SELECT id, email, status, unsubscribe_token FROM subscribers WHERE email = $1',
      [activeEmail],
    );
    assert.equal(activeRows.length, 1);
    assert.equal(activeRows[0].status, 'active');
    subscriberIds.push(activeRows[0].id);
    await service.subscribe(activeEmail);
    const { rows: duplicateRows } = await pool.query(
      'SELECT id, unsubscribe_token FROM subscribers WHERE email = $1',
      [activeEmail],
    );
    assert.equal(duplicateRows[0].id, activeRows[0].id);
    assert.equal(duplicateRows[0].unsubscribe_token, activeRows[0].unsubscribe_token);

    const pendingId = randomUUID();
    const verificationToken = randomBytes(32).toString('base64url');
    subscriberIds.push(pendingId);
    await pool.query(
      `INSERT INTO subscribers
         (id, email, status, verification_token, unsubscribe_token,
          verified_at, subscribed_at, unsubscribed_at)
       VALUES ($1, $2, 'pending', $3, NULL, NULL, NULL, NULL)`,
      [pendingId, `pending-${randomUUID()}@example.test`, verificationToken],
    );
    assert.deepEqual(await service.verify(verificationToken), { ok: true });
    const { rows: verifiedRows } = await pool.query(
      'SELECT status, verification_token, unsubscribe_token FROM subscribers WHERE id = $1',
      [pendingId],
    );
    assert.equal(verifiedRows[0].status, 'active');
    assert.equal(verifiedRows[0].verification_token, null);
    assert.deepEqual(await service.unsubscribe(createUnsubscribeToken(
      pendingId,
      verifiedRows[0].unsubscribe_token,
      config.tokenSecret,
    )), { ok: true });

    const unsubscribeLink = createUnsubscribeToken(
      activeRows[0].id,
      activeRows[0].unsubscribe_token,
      config.tokenSecret,
    );
    assert.deepEqual(await service.unsubscribe(unsubscribeLink), { ok: true });
    assert.deepEqual(await service.unsubscribe(unsubscribeLink), { ok: true });
    await service.subscribe(activeEmail);
    const { rows: resubscribedRows } = await pool.query(
      'SELECT id, status, unsubscribe_token FROM subscribers WHERE email = $1',
      [activeEmail],
    );
    assert.equal(resubscribedRows[0].id, activeRows[0].id);
    assert.equal(resubscribedRows[0].status, 'active');
    assert.notEqual(resubscribedRows[0].unsubscribe_token, activeRows[0].unsubscribe_token);

    const retryEmail = `retry-${randomUUID()}@example.test`;
    await service.subscribe(retryEmail);
    const { rows: retryRows } = await pool.query(
      'SELECT id FROM subscribers WHERE email = $1',
      [retryEmail],
    );
    subscriberIds.push(retryRows[0].id);

    await pool.query(
      `INSERT INTO newsletters (id, title, subject, html_content, send_at, status)
       VALUES ($1, $2, $3, $4, NOW(), 'scheduled')`,
      [newsletterId, 'Integration test', 'Integration test', '<p>Test newsletter</p>'],
    );

    const firstPassEmails = [];
    let firstEmailStarted;
    const firstEmailStartedPromise = new Promise((resolve) => {
      firstEmailStarted = resolve;
    });
    const emailHold = new Promise((resolve) => {
      releaseEmailHold = resolve;
    });
    const firstService = createNewsletterService({
      pool,
      emailService: {
        async sendEmail({ to }) {
          firstPassEmails.push(to);
          firstEmailStarted();
          await emailHold;
          if (to === retryEmail) throw new Error('Simulated temporary email failure');
        },
      },
      config,
      logger: { info() {}, error() {} },
    });
    const concurrentService = createNewsletterService({
      pool,
      emailService: { async sendEmail() { throw new Error('Unexpected duplicate send'); } },
      config,
      logger: { info() {}, error() {} },
    });
    const firstProcessing = firstService.processDueNewsletters();
    await firstEmailStartedPromise;
    await pool.query(
      `UPDATE newsletters
       SET updated_at = NOW() - INTERVAL '2 minutes'
       WHERE id = $1`,
      [newsletterId],
    );
    assert.equal(await concurrentService.processDueNewsletters(), 0);
    assert.equal(firstPassEmails.filter((email) => email === retryEmail).length, 1);
    assert.equal(firstPassEmails.filter((email) => email === activeEmail).length, 0);
    assert.equal(firstPassEmails.length, 1);
    releaseEmailHold();
    releaseEmailHold = undefined;
    assert.equal(await firstProcessing, 1);

    const { rows: firstDeliveryRows } = await pool.query(
      `SELECT status, attempts FROM newsletter_deliveries
       WHERE newsletter_id = $1 AND subscriber_id = $2`,
      [newsletterId, retryRows[0].id],
    );
    assert.equal(firstDeliveryRows[0].status, 'failed');
    assert.equal(firstDeliveryRows[0].attempts, 1);

    await pool.query(
      `UPDATE newsletters
       SET status = 'scheduled', send_at = NOW()
       WHERE id = $1`,
      [newsletterId],
    );
    const retryService = createNewsletterService({
      pool,
      emailService: { async sendEmail() {} },
      config,
      logger: { info() {}, error() {} },
    });
    assert.equal(await retryService.processDueNewsletters(), 1);

    const { rows: retriedDeliveryRows } = await pool.query(
      `SELECT status, attempts FROM newsletter_deliveries
       WHERE newsletter_id = $1 AND subscriber_id = $2`,
      [newsletterId, retryRows[0].id],
    );
    const { rows: newsletterRows } = await pool.query(
      'SELECT status FROM newsletters WHERE id = $1',
      [newsletterId],
    );
    assert.equal(retriedDeliveryRows[0].status, 'sent');
    assert.equal(retriedDeliveryRows[0].attempts, 2);
    assert.equal(newsletterRows[0].status, 'sent');
  } finally {
    releaseEmailHold?.();
    if (schemaReady) {
      await pool.query('DELETE FROM newsletters WHERE id = $1', [newsletterId]);
      if (subscriberIds.length > 0) {
        await pool.query('DELETE FROM subscribers WHERE id = ANY($1::uuid[])', [subscriberIds]);
      }
    }
    await pool.end();
  }
});

test('PostgreSQL market snapshot refresh, advisory lock, failure preservation and read', {
  skip: !integrationEnabled,
}, async () => {
  const pool = createDatabase(loadDatabaseConfig());
  // Test-only instrument IDs so production snapshot rows are never touched.
  const instrumentId = `ITEST_${randomBytes(4).toString('hex').toUpperCase()}`;
  const feeds = [{
    id: 'integration-rates',
    url: 'https://snapdata.integration.test/rates/world/latest.json',
    dataset: 'rates',
    scope: 'world',
    unit: 'percent',
    currency: 'USD',
    instruments: [{ id: instrumentId, sourceInstrument: 'UST2Y', displayName: 'Integration 2Y', min: -5, max: 30 }],
  }];
  const marketConfig = { marketSnapshot: { requestTimeoutMs: 2000, staleAfterHours: 36, minIntervalMinutes: 10 } };
  const logger = { info() {}, warn() {}, error() {} };
  const startedAt = new Date();
  const ratesBody = JSON.stringify({
    schema_version: '1.0',
    generated_at: '2026-10-20T21:30:00Z',
    dataset: 'rates',
    scope: 'world',
    resolution: 'daily',
    unit: { quantity: 'percent', currency: 'USD' },
    sources: [{ id: 'treasury', name: 'US Department of the Treasury', url: 'https://home.treasury.gov/' }],
    observations: [{ date: '2026-10-20', instrument: 'UST2Y', value: 4.79, prev_close: 4.77, change_pct: 0.4193, status: 'provisional', filled_from: null, source: 'treasury' }],
  });
  const okResponse = () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    async text() { return ratesBody; },
  });

  try {
    await migrateDatabase(pool);

    let releaseFetch;
    const fetchHeld = new Promise((resolve) => { releaseFetch = resolve; });
    const first = createMarketSnapshotService({
      pool, config: marketConfig, logger, feeds,
      fetchImpl: async () => { await fetchHeld; return okResponse(); },
    });
    const second = createMarketSnapshotService({
      pool, config: marketConfig, logger, feeds,
      fetchImpl: async () => { throw new Error('Unexpected concurrent fetch'); },
    });
    const firstRefresh = first.refresh({ trigger: 'manual', force: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(await second.refresh({ trigger: 'manual', force: true }), { status: 'skipped', reason: 'locked' });
    releaseFetch();
    assert.equal((await firstRefresh).status, 'succeeded');

    const failing = createMarketSnapshotService({
      pool, config: marketConfig, logger, feeds,
      fetchImpl: async () => ({ ok: false, status: 503, headers: { get: () => 'text/html' }, async text() { return ''; } }),
    });
    assert.equal((await failing.refresh({ trigger: 'manual', force: true })).status, 'failed');

    const snapshot = await failing.getLatestSnapshot();
    const [item] = snapshot.instruments;
    assert.equal(item.id, instrumentId);
    assert.equal(item.value, 4.79);
    assert.equal(item.previousClose, 4.77);
    assert.equal(item.change, 0.02);
    assert.equal(item.dataDate, '2026-10-20');
    assert.equal(item.lastAttemptStatus, 'error');
    assert.equal(snapshot.status, 'partial');
  } finally {
    await pool.query('DELETE FROM market_snapshots WHERE instrument = $1', [instrumentId]).catch(() => {});
    await pool.query(
      `DELETE FROM market_snapshot_runs WHERE run_trigger = 'manual' AND started_at >= $1 AND details::text LIKE $2`,
      [startedAt, `%${instrumentId}%`],
    ).catch(() => {});
    await pool.end();
  }
});
