import assert from 'node:assert/strict';
import test from 'node:test';
import { createNewsletterService } from '../src/newsletterService.js';

const config = {
  apiPublicUrl: 'https://newsletter.example.com',
  siteUrl: 'https://blog.derivionacademy.in',
  tokenSecret: 'service-test-token-secret-with-more-than-32-bytes',
  batchSize: 10,
  sendConcurrency: 2,
  staleSendMinutes: 30,
};

test('new subscriptions are active immediately without sending a confirmation email', async () => {
  const saved = [];
  let emailsSent = 0;
  const pool = {
    async query(sql, parameters) {
      assert.match(sql, /insert into public\.subscribers/);
      assert.match(sql, /values \(\$1, 'active', null, gen_random_uuid\(\), null, now\(\), null\)/);
      assert.match(sql, /where public\.subscribers\.status in \('pending', 'unsubscribed'\)/);
      saved.push({ email: parameters[0] });
      return { rows: [{ id: 'subscriber-id', email: parameters[0], status: 'active' }] };
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

test('resubscription activates prior addresses and duplicate active addresses are left unchanged', async () => {
  let saved = false;
  let emailsSent = 0;
  const service = createNewsletterService({
    pool: {
      async query(sql) {
        assert.match(sql, /status = 'active'/);
        if (saved) {
          return { rows: [] };
        }
        saved = true;
        assert.match(sql, /unsubscribe_token = gen_random_uuid\(\)/);
        return { rows: [{ id: 'subscriber-id', email: 'reader@example.com', status: 'active' }] };
      },
    },
    emailService: { async sendEmail() { emailsSent += 1; } },
    config,
    logger: { error() {} },
  });

  const firstResult = await service.subscribe('reader@example.com');
  const duplicateResult = await service.subscribe('reader@example.com');
  assert.equal(firstResult.message, 'You are subscribed to the weekly newsletter.');
  assert.equal(duplicateResult.message, 'You are subscribed to the weekly newsletter.');
  assert.equal(emailsSent, 0);
});

test('verification activates a pending subscriber and clears its token', async () => {
  const token = 'b'.repeat(43);
  let queryParameters;
  const service = createNewsletterService({
    pool: {
      async query(sql, parameters) {
        assert.match(sql, /status = 'active'/);
        assert.match(sql, /verification_token = null/);
        assert.match(sql, /unsubscribe_token = gen_random_uuid\(\)/);
        queryParameters = parameters;
        return { rowCount: 1 };
      },
    },
    emailService: {},
    config,
  });

  assert.deepEqual(await service.verify(token), { ok: true });
  assert.deepEqual(queryParameters, [token]);
  assert.deepEqual(await service.verify('invalid'), { ok: false });
});

test('unsubscribe marks a subscriber and is idempotent', async () => {
  const subscriberId = '4a2e8658-13e8-4e66-a146-66ef051a7e48';
  const unsubscribeNonce = 'fdcb2571-ef39-4c49-aa98-c9a3f9f0a002';
  let updateCount = 0;
  const service = createNewsletterService({
    pool: {
      async query(sql, parameters) {
        if (sql.includes('update public.subscribers')) {
          assert.match(sql, /status = 'unsubscribed'/);
          assert.match(sql, /coalesce\(unsubscribed_at, now\(\)\)/);
          assert.deepEqual(parameters, [subscriberId, unsubscribeNonce]);
          updateCount += 1;
          return { rowCount: updateCount === 1 ? 1 : 0 };
        }
        assert.match(sql, /status = 'unsubscribed'/);
        assert.deepEqual(parameters, [subscriberId, unsubscribeNonce]);
        return { rowCount: 1 };
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
