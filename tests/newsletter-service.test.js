import assert from 'node:assert/strict';
import test from 'node:test';
import { createNewsletterService } from '../src/newsletterService.js';
import { createUnsubscribeToken } from '../src/tokens.js';

const config = {
  apiPublicUrl: 'https://newsletter.example.com',
  siteUrl: 'https://site.example.com',
  tokenSecret: 'service-test-token-secret-with-more-than-32-bytes',
  batchSize: 10,
  sendConcurrency: 2,
  staleSendMinutes: 30,
};

test('new subscriptions are active immediately and emails are normalized', async () => {
  const saved = [];
  let emailsSent = 0;
  const service = createNewsletterService({
    pool: {
      async query(sql, parameters) {
        assert.match(sql, /INSERT INTO subscribers/);
        assert.match(sql, /ON CONFLICT \(email\) DO UPDATE/);
        assert.match(sql, /subscribers\.status IN \('pending', 'unsubscribed'\)/);
        saved.push({ email: parameters[1] });
        return { rowCount: 1, rows: [] };
      },
    },
    emailService: { async sendEmail() { emailsSent += 1; } },
    config,
    logger: { error() {} },
  });

  const result = await service.subscribe('  Reader@Example.COM ');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].email, 'reader@example.com');
  assert.equal(emailsSent, 0);
  assert.equal(result.message, 'You are subscribed to the weekly newsletter.');
});

test('verification and unsubscribe use PostgreSQL result counts and unsubscribe is idempotent', async () => {
  const subscriberId = '4a2e8658-13e8-4e66-a146-66ef051a7e48';
  const unsubscribeNonce = 'fdcb2571-ef39-4c49-aa98-c9a3f9f0a002';
  let active = true;
  const service = createNewsletterService({
    pool: {
      async query(sql, parameters) {
        if (sql.includes("SET status = 'active'")) {
          assert.match(sql, /unsubscribe_token = \$1/);
          assert.equal(parameters[1], 'b'.repeat(43));
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes("SET status = 'unsubscribed'")) {
          assert.match(sql, /COALESCE\(unsubscribed_at, NOW\(\)\)/);
          assert.deepEqual(parameters, [subscriberId, unsubscribeNonce]);
          if (!active) return { rowCount: 0, rows: [] };
          active = false;
          return { rowCount: 1, rows: [] };
        }
        assert.match(sql, /status = 'unsubscribed'/);
        assert.deepEqual(parameters, [subscriberId, unsubscribeNonce]);
        return { rowCount: 1, rows: [{}] };
      },
    },
    emailService: {},
    config,
  });

  assert.deepEqual(await service.verify('b'.repeat(43)), { ok: true });
  assert.deepEqual(await service.verify('invalid'), { ok: false });
  const token = createUnsubscribeToken(subscriberId, unsubscribeNonce, config.tokenSecret);
  assert.deepEqual(await service.unsubscribe(token), { ok: true });
  assert.deepEqual(await service.unsubscribe(token), { ok: true });
});

test('manual sends reuse the campaign and avoid resending to previous recipients', async () => {
  const htmlContent = '<html><body><h1>Market update</h1></body></html>';
  let campaign;
  const deliveries = new Map();
  const subscribers = [{
    id: '00000000-0000-4000-8000-000000000001',
    email: 'reader@example.com',
    unsubscribe_token: 'fdcb2571-ef39-4c49-aa98-c9a3f9f0a001',
  }];
  const client = {
    async query(sql, parameters = []) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)
        || sql.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }
      if (sql.includes('FROM newsletters')) {
        const rows = campaign?.title === parameters[0]
          && campaign.subject === parameters[1]
          && campaign.html_content === parameters[2]
          ? [campaign]
          : [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("SET status = 'sending'")) {
        campaign.status = 'sending';
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO newsletters')) {
        campaign = {
          id: parameters[0],
          title: parameters[1],
          subject: parameters[2],
          html_content: parameters[3],
          status: 'sending',
        };
        return { rowCount: 1, rows: [campaign] };
      }
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
    release() {},
  };
  const pool = {
    async connect() { return client; },
    async query(sql, parameters = []) {
      if (sql.includes('SELECT subscriber.id, subscriber.email')) {
        const [lastId, , limit] = parameters;
        const rows = subscribers
          .filter((subscriber) => subscriber.id > lastId
            && deliveries.get(`${campaign.id}:${subscriber.id}`) !== 'sent')
          .slice(0, limit);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('INSERT INTO newsletter_deliveries')) {
        const key = `${parameters[0]}:${parameters[1]}`;
        if (deliveries.get(key) !== 'sent') deliveries.set(key, 'sending');
        return { rows: [{ status: deliveries.get(key) }], rowCount: 1 };
      }
      if (sql.includes('UPDATE newsletter_deliveries')) {
        const [newsletterId, subscriberId] = sql.includes("status = 'sent'")
          ? parameters
          : parameters.slice(1);
        const key = `${newsletterId}:${subscriberId}`;
        deliveries.set(key, sql.includes("status = 'sent'") ? 'sent' : 'failed');
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("SET status = 'failed'")) {
        campaign.status = 'failed';
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('SET status = $1')) {
        campaign.status = parameters[0];
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('UPDATE newsletters')) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected database query: ${sql}`);
    },
  };
  let emailsSent = 0;
  const service = createNewsletterService({
    pool,
    emailService: { async sendEmail() { emailsSent += 1; } },
    config,
    logger: { info() {}, error() {} },
  });
  const request = {
    title: 'Weekly Market Update',
    subject: 'This Week in Financial Markets',
    htmlContent,
  };

  const firstResult = await service.sendNewsletterNow(request);
  assert.equal(firstResult.status, 'sent');
  assert.equal(firstResult.sentCount, 1);
  assert.equal(emailsSent, 1);

  subscribers.push({
    id: '00000000-0000-4000-8000-000000000002',
    email: 'new-reader@example.com',
    unsubscribe_token: 'fdcb2571-ef39-4c49-aa98-c9a3f9f0a002',
  });

  const secondResult = await service.sendNewsletterNow(request);
  assert.equal(secondResult.newsletterId, firstResult.newsletterId);
  assert.equal(secondResult.sentCount, 1);
  assert.equal(emailsSent, 2);
  assert.equal(deliveries.get(`${firstResult.newsletterId}:${subscribers[0].id}`), 'sent');
  assert.equal(deliveries.get(`${firstResult.newsletterId}:${subscribers[1].id}`), 'sent');

  const resendResult = await service.sendNewsletterNow({ ...request, resend: true });
  assert.notEqual(resendResult.newsletterId, firstResult.newsletterId);
  assert.equal(resendResult.sentCount, 2);
  assert.equal(emailsSent, 4);
});
