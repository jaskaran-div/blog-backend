import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const env = {
  DATABASE_URL: 'postgresql://newsletter:password@localhost:5432/newsletter',
  SES_FROM_EMAIL: 'newsletter@blog.derivionacademy.in',
  NEWSLETTER_TOKEN_SECRET: 'token-secret-with-at-least-thirty-two-bytes',
  NEWSLETTER_ADMIN_TOKEN: 'admin-secret-with-at-least-thirty-two-bytes',
  NEWSLETTER_SITE_URL: 'https://blog.derivionacademy.in',
  NEWSLETTER_API_PUBLIC_URL: 'https://api.example.com',
  ALLOWED_ORIGINS: 'https://blog.derivionacademy.in,http://localhost:3000',
};

test('loads region, defaults and origins from backend environment values', () => {
  const config = loadConfig(env);

  assert.equal(config.awsRegion, 'ap-southeast-2');
  assert.equal(config.port, 4000);
  assert.equal(config.batchSize, 50);
  assert.equal(config.sendConcurrency, 5);
  assert.equal(config.databaseSsl, true);
  assert.deepEqual(config.allowedOrigins, [
    'https://blog.derivionacademy.in',
    'http://localhost:3000',
  ]);
});

test('rejects partial AWS credentials and weak token secrets', () => {
  assert.throws(
    () => loadConfig({ ...env, AWS_ACCESS_KEY_ID: 'access-key' }),
    /Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/,
  );
  assert.throws(
    () => loadConfig({ ...env, NEWSLETTER_TOKEN_SECRET: 'short' }),
    /NEWSLETTER_TOKEN_SECRET must contain at least 32 bytes/,
  );
});
