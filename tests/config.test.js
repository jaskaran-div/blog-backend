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

test('market snapshot schedule is disabled by default and uses Asia/Kolkata', () => {
  const { marketSnapshot } = loadConfig(env);

  assert.equal(marketSnapshot.timezone, 'Asia/Kolkata');
  assert.deepEqual(marketSnapshot.times, []);
  assert.deepEqual(marketSnapshot.cronExpressions, []);
  assert.equal(marketSnapshot.requestTimeoutMs, 10_000);
  assert.equal(marketSnapshot.staleAfterHours, 36);
  assert.equal(marketSnapshot.minIntervalMinutes, 10);
  assert.equal(marketSnapshot.bootstrapIfEmpty, true);
});

test('market snapshot times become cron expressions in the configured days', () => {
  const { marketSnapshot } = loadConfig({
    ...env,
    MARKET_SNAPSHOT_TIMES: ' 08:30, 20:05 ,08:30',
    MARKET_SNAPSHOT_DAYS: '1-5',
    MARKET_SNAPSHOT_BOOTSTRAP_IF_EMPTY: 'false',
  });

  assert.deepEqual(marketSnapshot.times, ['08:30', '20:05']);
  assert.deepEqual(marketSnapshot.cronExpressions, ['30 8 * * 1-5', '5 20 * * 1-5']);
  assert.equal(marketSnapshot.staleAfterHours, 84);
  assert.equal(marketSnapshot.bootstrapIfEmpty, false);
  assert.equal(loadConfig({ ...env, MARKET_SNAPSHOT_STALE_AFTER_HOURS: '12' }).marketSnapshot.staleAfterHours, 12);
});

test('rejects invalid market snapshot settings', () => {
  for (const [name, value, message] of [
    ['MARKET_SNAPSHOT_TIMES', '9:00', /24-hour HH:MM/],
    ['MARKET_SNAPSHOT_TIMES', '24:00', /24-hour HH:MM/],
    ['MARKET_SNAPSHOT_TIMES', '09:00,09:05', /further apart/],
    ['MARKET_SNAPSHOT_TIMES', '23:58,00:03', /further apart/],
    ['MARKET_SNAPSHOT_TIMEZONE', 'Mars/Olympus', /valid IANA timezone/],
    ['MARKET_SNAPSHOT_DAYS', '9', /day-of-week/],
    ['MARKET_SNAPSHOT_TIMEOUT_MS', '0', /positive integer/],
    ['MARKET_SNAPSHOT_BOOTSTRAP_IF_EMPTY', 'maybe', /true or false/],
  ]) {
    assert.throws(() => loadConfig({ ...env, [name]: value }), message, `${name}=${value}`);
  }
});
