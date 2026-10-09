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
  let updateCount = 0;
  const service = createNewsletterService({
    pool: {
      async execute(sql, parameters) {
        if (sql.includes('UPDATE subscribers')) {
          assert.match(sql, /status = 'unsubscribed'/);
          assert.match(sql, /COALESCE\(unsubscribed_at, CURRENT_TIMESTAMP/);
          assert.deepEqual(parameters, [subscriberId, unsubscribeNonce]);
          updateCount += 1;
          return [{ affectedRows: updateCount === 1 ? 1 : 0 }];
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
