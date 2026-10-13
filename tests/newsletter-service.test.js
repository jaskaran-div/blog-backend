import assert from 'node:assert/strict';
import test from 'node:test';
import { createNewsletterService } from '../src/newsletterService.js';

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
  const pool = {
    async execute(sql, parameters) {
      assert.match(sql, /INSERT INTO subscribers/);
      assert.match(sql, /ON DUPLICATE KEY UPDATE/);
      assert.match(sql, /status IN \('pending', 'unsubscribed'\)/);
      saved.push({ email: parameters[1] });
      return [{ affectedRows: 1 }];
    },
  };
  const service = createNewsletterService({
    pool,
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

test('resubscription uses a conditional MySQL upsert without rotating active subscriptions', async () => {
  const queries = [];
  const service = createNewsletterService({
    pool: {
      async execute(sql, parameters) {
        queries.push({ sql, parameters });
        return [{ affectedRows: queries.length === 1 ? 1 : 0 }];
      },
    },
    emailService: { async sendEmail() {} },
    config,
    logger: { error() {} },
  });

  const firstResult = await service.subscribe('reader@example.com');
  const duplicateResult = await service.subscribe('reader@example.com');
  assert.equal(firstResult.message, 'You are subscribed to the weekly newsletter.');
  assert.equal(duplicateResult.message, 'You are subscribed to the weekly newsletter.');
  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /status = IF\(status IN/);
  assert.deepEqual(queries[0].parameters.slice(1, 2), ['reader@example.com']);
  assert.notEqual(queries[0].parameters[2], queries[1].parameters[2]);
});

test('verification activates a pending subscriber and clears its token', async () => {
  const token = 'b'.repeat(43);
  let queryParameters;
  const service = createNewsletterService({
    pool: {
      async execute(sql, parameters) {
        assert.match(sql, /SET status = 'active'/);
        assert.match(sql, /verification_token = NULL/);
        assert.match(sql, /unsubscribe_token = \?/);
        queryParameters = parameters;
        return [{ affectedRows: 1 }];
      },
    },
    emailService: {},
    config,
  });

  assert.deepEqual(await service.verify(token), { ok: true });
  assert.equal(queryParameters[1], token);
  assert.deepEqual(await service.verify('invalid'), { ok: false });
});

test('unsubscribe marks a subscriber and is idempotent using affectedRows', async () => {
  const subscriberId = '4a2e8658-13e8-4e66-a146-66ef051a7e48';
  const unsubscribeNonce = 'fdcb2571-ef39-4c49-aa98-c9a3f9f0a002';
  let active = true;
  const service = createNewsletterService({
    pool: {
      async execute(sql, parameters) {
        if (sql.includes('UPDATE subscribers')) {
          assert.match(sql, /status = 'unsubscribed'/);
          assert.match(sql, /COALESCE\(unsubscribed_at, CURRENT_TIMESTAMP/);
          assert.deepEqual(parameters, [subscriberId, unsubscribeNonce]);
          if (!active) return [{ affectedRows: 0 }];
          active = false;
          return [{ affectedRows: 1 }];
        }
        assert.match(sql, /status = 'unsubscribed'/);
        assert.deepEqual(parameters, [subscriberId, unsubscribeNonce]);
        return [[{}]];
      },
    },
    emailService: {},
    config,
  });
  const { createUnsubscribeToken } = await import('../src/tokens.js');
  const token = createUnsubscribeToken(subscriberId, unsubscribeNonce, config.tokenSecret);

  assert.deepEqual(await service.unsubscribe(token), { ok: true });
  assert.deepEqual(await service.unsubscribe(token), { ok: true });
});

test('manual sends reuse the campaign and send only to active subscribers without a sent delivery', async () => {
  const htmlContent = '<html><body><h1>Market update</h1></body></html>';
  let campaign = null;
  const deliveries = new Map();
  const subscribers = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'reader@example.com',
      unsubscribe_token: 'fdcb2571-ef39-4c49-aa98-c9a3f9f0a001',
    },
  ];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql, parameters = []) {
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
      if (sql.includes('FROM newsletters')) {
        return [[campaign?.title === parameters[0]
          && campaign.subject === parameters[1]
          && campaign.html_content === parameters[2]
          ? campaign
          : null].filter(Boolean)];
      }
      if (sql.includes('UPDATE newsletters')) {
        campaign.status = 'sending';
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('INSERT INTO newsletters')) {
        campaign = {
          id: parameters[0],
          title: parameters[1],
          subject: parameters[2],
          html_content: parameters[3],
          status: 'sending',
        };
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
  };
  const pool = {
    async getConnection() { return connection; },
    async execute(sql, parameters = []) {
      if (sql.includes('SELECT subscriber.id, subscriber.email')) {
        const [lastId, , limit] = parameters;
        return [subscribers
            .filter((subscriber) => subscriber.id > lastId
              && deliveries.get(`${campaign.id}:${subscriber.id}`) !== 'sent')
            .slice(0, limit)];
      }
      if (sql.includes('INSERT INTO newsletter_deliveries')) {
        const key = `${parameters[0]}:${parameters[1]}`;
        if (deliveries.get(key) !== 'sent') {
          deliveries.set(key, 'sending');
        }
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('SELECT status FROM newsletter_deliveries')) {
        const status = deliveries.get(`${parameters[0]}:${parameters[1]}`);
        return [[{ status }].filter((row) => row.status)];
      }
      if (sql.includes("SET status = 'sent'")) {
        deliveries.set(`${parameters[0]}:${parameters[1]}`, 'sent');
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("SET status = 'failed'")) {
        deliveries.set(`${parameters[1]}:${parameters[2]}`, 'failed');
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('SET updated_at')) {
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('SET status = ?')) {
        campaign.status = parameters[0];
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('UPDATE newsletters')) {
        return [{ affectedRows: 1 }];
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
  const firstCampaignId = firstResult.newsletterId;
  assert.deepEqual(firstResult, {
    newsletterId: firstCampaignId,
    status: 'sent',
    sentCount: 1,
    failedCount: 0,
  });
  assert.equal(emailsSent, 1);

  subscribers.push({
    id: '00000000-0000-4000-8000-000000000002',
    email: 'new-reader@example.com',
    unsubscribe_token: 'fdcb2571-ef39-4c49-aa98-c9a3f9f0a002',
  });

  const secondResult = await service.sendNewsletterNow(request);
  assert.deepEqual(secondResult, {
    newsletterId: firstCampaignId,
    status: 'sent',
    sentCount: 1,
    failedCount: 0,
  });
  assert.equal(emailsSent, 2);
  assert.equal(deliveries.get(`${firstCampaignId}:${subscribers[0].id}`), 'sent');
  assert.equal(deliveries.get(`${firstCampaignId}:${subscribers[1].id}`), 'sent');

  const resendResult = await service.sendNewsletterNow({ ...request, resend: true });
  assert.deepEqual(resendResult, {
    newsletterId: resendResult.newsletterId,
    status: 'sent',
    sentCount: 2,
    failedCount: 0,
  });
  assert.equal(emailsSent, 4);
  assert.notEqual(resendResult.newsletterId, firstCampaignId);
  assert.equal(deliveries.get(`${resendResult.newsletterId}:${subscribers[0].id}`), 'sent');
  assert.equal(deliveries.get(`${resendResult.newsletterId}:${subscribers[1].id}`), 'sent');
});
