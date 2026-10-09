import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDatabase } from '../src/db.js';
import { loadDatabaseConfig } from '../src/config.js';
import { migrateDatabase } from '../src/migrations.js';
import { createNewsletterService } from '../src/newsletterService.js';
import { createUnsubscribeToken } from '../src/tokens.js';

const integrationEnabled = process.env.MYSQL_INTEGRATION_TEST === '1';
const config = {
  apiPublicUrl: 'https://newsletter.integration.test',
  tokenSecret: 'mysql-integration-token-secret-with-more-than-32-bytes',
  batchSize: 10,
  sendConcurrency: 2,
  staleSendMinutes: 1,
};

test('MySQL migration, subscription lifecycle, concurrent claims, delivery and retries', {
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

    const [tables] = await pool.execute(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME IN ('subscribers', 'newsletters', 'newsletter_deliveries')`,
    );
    assert.deepEqual(new Set(tables.map((table) => table.TABLE_NAME)), new Set([
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
    const [activeRows] = await pool.execute(
      'SELECT id, email, status, unsubscribe_token FROM subscribers WHERE email = ?',
      [activeEmail],
    );
    assert.equal(activeRows.length, 1);
    assert.equal(activeRows[0].status, 'active');
    subscriberIds.push(activeRows[0].id);
    await service.subscribe(activeEmail);
    const [duplicateRows] = await pool.execute(
      'SELECT id, unsubscribe_token FROM subscribers WHERE email = ?',
      [activeEmail],
    );
    assert.equal(duplicateRows[0].id, activeRows[0].id);
    assert.equal(duplicateRows[0].unsubscribe_token, activeRows[0].unsubscribe_token);

    const pendingId = randomUUID();
    const verificationToken = randomBytes(32).toString('base64url');
    subscriberIds.push(pendingId);
    await pool.execute(
      `INSERT INTO subscribers
         (id, email, status, verification_token, unsubscribe_token,
          verified_at, subscribed_at, unsubscribed_at)
       VALUES (?, ?, 'pending', ?, NULL, NULL, NULL, NULL)`,
      [pendingId, `pending-${randomUUID()}@example.test`, verificationToken],
    );
    assert.deepEqual(await service.verify(verificationToken), { ok: true });
    const [verifiedRows] = await pool.execute(
      'SELECT status, verification_token, unsubscribe_token FROM subscribers WHERE id = ?',
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
    const [resubscribedRows] = await pool.execute(
      'SELECT id, status, unsubscribe_token FROM subscribers WHERE email = ?',
      [activeEmail],
    );
    assert.equal(resubscribedRows[0].id, activeRows[0].id);
    assert.equal(resubscribedRows[0].status, 'active');
    assert.notEqual(resubscribedRows[0].unsubscribe_token, activeRows[0].unsubscribe_token);
    assert.deepEqual(await service.unsubscribe(createUnsubscribeToken(
      activeRows[0].id,
      resubscribedRows[0].unsubscribe_token,
      config.tokenSecret,
    )), { ok: true });

    const retryEmail = `retry-${randomUUID()}@example.test`;
    await service.subscribe(retryEmail);
    const [retryRows] = await pool.execute(
      'SELECT id FROM subscribers WHERE email = ?',
      [retryEmail],
    );
    subscriberIds.push(retryRows[0].id);

    await pool.execute(
      `INSERT INTO newsletters (id, title, subject, html_content, send_at, status)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3), 'scheduled')`,
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
          if (to === retryEmail) {
            throw new Error('Simulated temporary email failure');
          }
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
    await pool.execute(
      `UPDATE newsletters
       SET updated_at = TIMESTAMPADD(MINUTE, -2, CURRENT_TIMESTAMP(3))
       WHERE id = ?`,
      [newsletterId],
    );
    assert.equal(await concurrentService.processDueNewsletters(), 0);
    assert.equal(firstPassEmails.filter((email) => email === retryEmail).length, 1);
    assert.equal(firstPassEmails.filter((email) => email === activeEmail).length, 0);
    assert.equal(firstPassEmails.length, 1);
    releaseEmailHold();
    releaseEmailHold = undefined;
    assert.equal(await firstProcessing, 1);

    const [firstDelivery] = await pool.execute(
      `SELECT status, attempts FROM newsletter_deliveries
       WHERE newsletter_id = ? AND subscriber_id = ?`,
      [newsletterId, retryRows[0].id],
    );
    assert.equal(firstDelivery.status, 'failed');
    assert.equal(firstDelivery.attempts, 1);

    await pool.execute(
      `UPDATE newsletters
       SET status = 'scheduled', send_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [newsletterId],
    );
    const retryService = createNewsletterService({
      pool,
      emailService: { async sendEmail() {} },
      config,
      logger: { info() {}, error() {} },
    });
    assert.equal(await retryService.processDueNewsletters(), 1);

    const [retriedDelivery] = await pool.execute(
      `SELECT status, attempts FROM newsletter_deliveries
       WHERE newsletter_id = ? AND subscriber_id = ?`,
      [newsletterId, retryRows[0].id],
    );
    const [newsletterRows] = await pool.execute(
      'SELECT status FROM newsletters WHERE id = ?',
      [newsletterId],
    );
    assert.equal(retriedDelivery.status, 'sent');
    assert.equal(retriedDelivery.attempts, 2);
    assert.equal(newsletterRows[0].status, 'sent');
  } finally {
    releaseEmailHold?.();
    if (schemaReady) {
      await pool.execute('DELETE FROM newsletters WHERE id = ?', [newsletterId]);
      if (subscriberIds.length > 0) {
        await pool.execute(
          `DELETE FROM subscribers WHERE id IN (${subscriberIds.map(() => '?').join(', ')})`,
          subscriberIds,
        );
      }
    }
    await pool.end();
  }
});
