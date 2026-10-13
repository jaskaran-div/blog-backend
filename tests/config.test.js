import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const env = {
  DATABASE_URL: 'postgresql://newsletter_user:test-password@ep-example.neon.tech/newsletter_test?sslmode=require',
  SES_FROM_EMAIL: 'newsletter@example.com',
  NEWSLETTER_TOKEN_SECRET: 'token-secret-with-at-least-thirty-two-bytes',
  NEWSLETTER_ADMIN_TOKEN: 'admin-secret-with-at-least-thirty-two-bytes',
  NEWSLETTER_SITE_URL: 'https://site.example.com',
  NEWSLETTER_API_PUBLIC_URL: 'https://api.example.com',
  ALLOWED_ORIGINS: 'https://site.example.com,http://localhost:3000',
};

test('loads Neon PostgreSQL settings, AWS defaults and allowed origins', () => {
  const config = loadConfig(env);

  assert.equal(config.databaseUrl, env.DATABASE_URL);
  assert.equal(config.awsRegion, 'ap-southeast-2');
  assert.equal(config.sesFromName, 'ISFT');
  assert.equal(config.port, 4000);
  assert.equal(config.trustProxyHops, 0);
  assert.equal(config.batchSize, 50);
  assert.equal(config.sendConcurrency, 5);
  assert.deepEqual(config.allowedOrigins, [
    'https://site.example.com',
    'http://localhost:3000',
  ]);
});

test('trusts the Render proxy by default and allows an explicit hop override', () => {
  assert.equal(
    loadConfig({ ...env, RENDER_EXTERNAL_URL: 'https://api.onrender.com' }).trustProxyHops,
    1,
  );
  assert.equal(
    loadConfig({
      ...env,
      RENDER_EXTERNAL_URL: 'https://api.onrender.com',
      TRUST_PROXY_HOPS: '0',
    }).trustProxyHops,
    1,
  );
  assert.equal(
    loadConfig({
      ...env,
      RENDER_EXTERNAL_URL: 'https://api.onrender.com',
      TRUST_PROXY_HOPS: '2',
    }).trustProxyHops,
    2,
  );
});

test('requires a valid PostgreSQL connection URL', () => {
  assert.throws(
    () => loadConfig({ ...env, DATABASE_URL: '' }),
    /Missing required environment variable: DATABASE_URL/,
  );
  assert.throws(
    () => loadConfig({ ...env, DATABASE_URL: 'https://example.com/db' }),
    /DATABASE_URL must be a valid PostgreSQL connection URL/,
  );
  assert.throws(
    () => loadConfig({ ...env, DATABASE_URL: 'postgresql://host' }),
    /DATABASE_URL must include a PostgreSQL protocol, host, username, and database name/,
  );
});

test('loads a custom SES sender display name and rejects header injection', () => {
  assert.equal(loadConfig({ ...env, SES_FROM_NAME: ' ISFT Weekly ' }).sesFromName, 'ISFT Weekly');
  assert.throws(
    () => loadConfig({ ...env, SES_FROM_NAME: 'ISFT\r\nBcc: attacker@example.com' }),
    /SES_FROM_NAME must not contain line breaks or angle brackets/,
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
