import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const env = {
  DB_HOST: 'mysql.example.test',
  DB_PORT: '3306',
  DB_NAME: 'newsletter_test',
  DB_USER: 'newsletter_user',
  DB_PASSWORD: 'test-password',
  SES_FROM_EMAIL: 'newsletter@example.com',
  NEWSLETTER_TOKEN_SECRET: 'token-secret-with-at-least-thirty-two-bytes',
  NEWSLETTER_ADMIN_TOKEN: 'admin-secret-with-at-least-thirty-two-bytes',
  NEWSLETTER_SITE_URL: 'https://site.example.com',
  NEWSLETTER_API_PUBLIC_URL: 'https://api.example.com',
  ALLOWED_ORIGINS: 'https://site.example.com,http://localhost:3000',
};

test('loads MySQL settings, AWS defaults and allowed origins', () => {
  const config = loadConfig(env);

  assert.equal(config.awsRegion, 'ap-southeast-2');
  assert.equal(config.port, 4000);
  assert.equal(config.batchSize, 50);
  assert.equal(config.sendConcurrency, 5);
  assert.equal(config.databaseHost, 'mysql.example.test');
  assert.equal(config.databasePort, 3306);
  assert.equal(config.databaseName, 'newsletter_test');
  assert.equal(config.databaseUser, 'newsletter_user');
  assert.equal(config.databasePassword, 'test-password');
  assert.deepEqual(config.allowedOrigins, [
    'https://site.example.com',
    'http://localhost:3000',
  ]);
});

test('requires GoDaddy MySQL settings and validates the port', () => {
  for (const name of ['DB_HOST', 'DB_NAME', 'DB_USER']) {
    assert.throws(
      () => loadConfig({ ...env, [name]: '' }),
      new RegExp(`Missing required environment variable: ${name}`),
    );
  }
  assert.throws(
    () => loadConfig({ ...env, DB_PORT: '65536' }),
    /DB_PORT must be between 1 and 65535/,
  );
  assert.throws(
    () => loadConfig({ ...env, DB_PASSWORD: '' }),
    /Missing required environment variable: DB_PASSWORD/,
  );
  assert.throws(
    () => loadConfig(Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'DB_HOST'))),
    /Missing required environment variable: DB_HOST/,
  );
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
