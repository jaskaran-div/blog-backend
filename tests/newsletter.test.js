import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createApp } from '../src/app.js';
import { createEmailService } from '../src/emailService.js';
import { createNewsletterService } from '../src/newsletterService.js';
import { createUnsubscribeToken, readUnsubscribeToken } from '../src/tokens.js';

const config = {
  allowedOrigins: ['http://localhost:3000'],
  adminToken: 'test-admin-token-secret-which-is-over-32-characters',
  apiPublicUrl: 'http://localhost:4000',
  siteUrl: 'http://localhost:3000',
  tokenSecret: 'test-newsletter-token-secret-at-least-32-bytes',
  sesFromEmail: 'newsletter@example.com',
  awsRegion: 'ap-southeast-2',
  awsAccessKeyId: '',
  awsSecretAccessKey: '',
  sendConcurrency: 2,
  batchSize: 3,
  staleSendMinutes: 30,
};

const app = createApp({
  config,
  logger: { error() {}, info() {} },
  newsletterService: {
    async subscribe(email) {
      if (typeof email !== 'string' || !email.includes('@')) {
        const error = new Error('Enter a valid email address.');
        error.statusCode = 400;
        throw error;
      }
      return { message: 'You are subscribed to the weekly newsletter.' };
    },
    async verify(token) {
      return { ok: token === 'verified-token' };
    },
    async unsubscribe(token) {
      return { ok: token === 'valid-unsubscribe-token' };
    },
    async sendTestEmail(options) {
      testEmailRequests.push(options);
      return { message: 'Test newsletter email sent.' };
    },
  },
  emailService: {
    async verifyConnection() {
      return { MaxSendRate: 10 };
    },
  },
});

const server = app.listen(0, '127.0.0.1');
await new Promise((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Could not start the newsletter API test server.');
}
const baseUrl = `http://127.0.0.1:${address.port}`;
const testEmailRequests = [];

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('subscription endpoint validates and returns a safe success response', async () => {
  const response = await fetch(`${baseUrl}/api/newsletter/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
    body: JSON.stringify({ email: 'reader@example.com' }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.deepEqual(await response.json(), {
    message: 'You are subscribed to the weekly newsletter.',
  });
});

test('verification and unsubscribe endpoints return simple HTML pages', async () => {
  const verified = await fetch(`${baseUrl}/api/newsletter/verify/verified-token`);
  assert.equal(verified.status, 200);
  assert.match(await verified.text(), /Your subscription is confirmed/);

  const unsubscribed = await fetch(`${baseUrl}/api/newsletter/unsubscribe/valid-unsubscribe-token`);
  assert.equal(unsubscribed.status, 200);
  assert.match(await unsubscribed.text(), /You will no longer receive/);
});

test('test endpoints require the admin token', async () => {
  const unauthorized = await fetch(`${baseUrl}/api/newsletter/test/ses`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${baseUrl}/api/newsletter/test/ses`, {
    headers: { 'x-newsletter-admin-token': config.adminToken },
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), {
    message: 'SES connection succeeded.',
    quota: { MaxSendRate: 10 },
  });

  const preview = await fetch(`${baseUrl}/api/newsletter/test/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-newsletter-admin-token': config.adminToken,
    },
    body: JSON.stringify({
      to: 'editor@example.com',
      subject: 'Preview',
      html_content: '<h1>Preview</h1>',
    }),
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(testEmailRequests, [{
    to: 'editor@example.com',
    subject: 'Preview',
    htmlContent: '<h1>Preview</h1>',
  }]);
});

test('unsubscribe tokens are signed and cannot be modified', () => {
  const id = '4a2e8658-13e8-4e66-a146-66ef051a7e48';
  const nonce = 'fdcb2571-ef39-4c49-aa98-c9a3f9f0a002';
  const token = createUnsubscribeToken(id, nonce, config.tokenSecret);
  assert.deepEqual(readUnsubscribeToken(token, config.tokenSecret), {
    subscriberId: id,
    unsubscribeToken: nonce,
  });
  assert.equal(readUnsubscribeToken(`${token}x`, config.tokenSecret), null);
  assert.equal(readUnsubscribeToken(token, 'a-different-secret-of-32-bytes'), null);
});

test('SES service retries throttling and sends HTML mail', async () => {
  let calls = 0;
  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      calls += 1;
      if (calls === 1) {
        const error = new Error('Rate exceeded');
        error.name = 'Throttling';
        throw error;
      }
      return { MessageId: 'test-message-id' };
    },
  };
  const emailService = createEmailService(config, client);
  await emailService.sendEmail({
    to: 'reader@example.com',
    subject: 'Weekly test',
    html: '<h1>Hello</h1>',
    text: 'Hello',
  });

  assert.equal(calls, 2);
  assert.equal(commands[1].input.Source, config.sesFromEmail);
  assert.equal(commands[1].input.Destination.ToAddresses[0], 'reader@example.com');
  assert.equal(commands[1].input.Message.Body.Html.Data, '<h1>Hello</h1>');
});

test('scheduled campaigns send only the active recipients in bounded batches', async () => {
  const subscribers = [
    { id: '00000000-0000-4000-8000-000000000001', email: 'one@example.com', unsubscribe_token: 'fdcb2571-ef39-4c49-aa98-c9a3f9f0a001' },
    { id: '00000000-0000-4000-8000-000000000002', email: 'two@example.com', unsubscribe_token: 'fdcb2571-ef39-4c49-aa98-c9a3f9f0a002' },
    { id: '00000000-0000-4000-8000-000000000003', email: 'three@example.com', unsubscribe_token: 'fdcb2571-ef39-4c49-aa98-c9a3f9f0a003' },
  ];
  const deliveries = new Map();
  const sent = [];
  let claimed = false;
  let simultaneous = 0;
  let maxSimultaneous = 0;

  const pool = {
    async query(sql, parameters = []) {
      if (sql.includes('with due as')) {
        if (claimed) return { rows: [] };
        claimed = true;
        return {
          rows: [{
            id: 'newsletter-id',
            title: 'Weekly Market Update',
            subject: 'This Week in Financial Markets',
            html_content: '<html><body><h1>Market update</h1></body></html>',
          }],
        };
      }

      if (sql.includes('select subscriber.id, subscriber.email')) {
        assert.match(sql, /subscriber\.status = 'active'/);
        const [, lastId, limit] = parameters;
        const rows = subscribers
          .filter((subscriber) => subscriber.id > lastId && !deliveries.has(subscriber.id))
          .slice(0, limit);
        return { rows };
      }

      if (sql.includes('insert into public.newsletter_deliveries')) {
        const [, subscriberId] = parameters;
        if (deliveries.get(subscriberId) === 'sent') return { rows: [] };
        deliveries.set(subscriberId, 'sending');
        return { rows: [{ status: 'sending' }] };
      }

      if (sql.includes("set status = 'sent'")) {
        const [, subscriberId] = parameters;
        deliveries.set(subscriberId, 'sent');
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("set status = 'failed'")) {
        const [, subscriberId] = parameters;
        deliveries.set(subscriberId, 'failed');
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("set updated_at = now() where id = $1 and status = 'sending'")) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('set status = $2')) {
        assert.equal(parameters[1], 'sent');
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected database query: ${sql}`);
    },
  };
  const emailService = {
    async sendEmail(message) {
      simultaneous += 1;
      maxSimultaneous = Math.max(maxSimultaneous, simultaneous);
      await new Promise((resolve) => setTimeout(resolve, 5));
      simultaneous -= 1;
      sent.push(message);
    },
  };
  const logger = { info() {}, error() {} };
  const service = createNewsletterService({ pool, emailService, config, logger });

  assert.equal(await service.processDueNewsletters(), 1);
  assert.equal(sent.length, 3);
  assert.ok(maxSimultaneous <= config.sendConcurrency);
  assert.ok(sent.every((message) => message.html.includes('/api/newsletter/unsubscribe/')));
  assert.ok(sent.every((message) => message.text.includes('Unsubscribe:')));
  assert.ok([...deliveries.values()].every((status) => status === 'sent'));
});
