import assert from 'node:assert/strict';
import test from 'node:test';
import cron from 'node-cron';
import { loadAutoNewsConfig } from '../src/config.js';

const credentials = {
  AUTO_NEWS_IMPORT_TOKEN: 'auto-news-import-token-with-at-least-32-bytes',
  GMAIL_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GMAIL_CLIENT_SECRET: 'client-secret',
  GMAIL_REFRESH_TOKEN: 'refresh-token',
  CLOUDINARY_CLOUD_NAME: 'demo',
  CLOUDINARY_API_KEY: '123',
  CLOUDINARY_API_SECRET: 'abc',
};

test('defaults keep automated news disabled and unpublished, with no credentials required', () => {
  const config = loadAutoNewsConfig({});

  assert.equal(config.enabled, false);
  assert.equal(config.autoPublish, false);
  assert.equal(config.sender, 'neil.crammond@zenithwavecapital.com');
  assert.equal(config.requireSenderAuth, true);
  assert.equal(config.timezone, 'Asia/Kolkata');
  assert.equal(config.cronExpression, '*/10 13,16 * * 0-5');
  assert.ok(cron.validate(config.cronExpression));
  assert.equal(config.lookbackDays, 3);
  assert.equal(config.maxAttempts, 5);
});

test('enabling requires the import token, Gmail and Cloudinary credentials', () => {
  assert.throws(() => loadAutoNewsConfig({ AUTO_NEWS_ENABLED: 'true' }), /AUTO_NEWS_IMPORT_TOKEN is required/);
  assert.throws(
    () => loadAutoNewsConfig({ AUTO_NEWS_ENABLED: 'true', AUTO_NEWS_IMPORT_TOKEN: credentials.AUTO_NEWS_IMPORT_TOKEN }),
    /GMAIL_CLIENT_ID/,
  );
  const config = loadAutoNewsConfig({ ...credentials, AUTO_NEWS_ENABLED: 'true', AUTO_NEWS_AUTO_PUBLISH: 'true' });
  assert.equal(config.enabled, true);
  assert.equal(config.autoPublish, true);
  assert.equal(config.cloudinary.cloudName, 'demo');
  assert.equal(config.gmail.user, 'me');
});

test('scripts can demand credentials without enabling the scheduler', () => {
  assert.throws(() => loadAutoNewsConfig({}, { requireCredentials: true }), /GMAIL_CLIENT_ID/);
});

test('reads Cloudinary credentials from CLOUDINARY_URL', () => {
  const config = loadAutoNewsConfig({ CLOUDINARY_URL: 'cloudinary://key123:se%2Fcret@my-cloud' });
  assert.deepEqual(config.cloudinary, { cloudName: 'my-cloud', apiKey: 'key123', apiSecret: 'se/cret' });
  assert.throws(() => loadAutoNewsConfig({ CLOUDINARY_URL: 'https://x' }), /CLOUDINARY_URL/);
});

test('validates the import token length, sender, interval and folder', () => {
  assert.throws(() => loadAutoNewsConfig({ AUTO_NEWS_IMPORT_TOKEN: 'short' }), /at least 32 bytes/);
  assert.throws(() => loadAutoNewsConfig({ AUTO_NEWS_SENDER: 'not-an-email' }), /AUTO_NEWS_SENDER/);
  assert.equal(loadAutoNewsConfig({ AUTO_NEWS_SENDER: ' Neil.Crammond@ZenithWaveCapital.com ' }).sender,
    'neil.crammond@zenithwavecapital.com');
  assert.equal(loadAutoNewsConfig({ AUTO_NEWS_CHECK_INTERVAL_MINUTES: '15' }).cronExpression, '*/15 13,16 * * 0-5');
  assert.equal(loadAutoNewsConfig({ AUTO_NEWS_CHECK_INTERVAL_MINUTES: '600' }).intervalMinutes, 60);
  assert.throws(() => loadAutoNewsConfig({ AUTO_NEWS_CHECK_INTERVAL_MINUTES: '0' }), /positive integer/);
  assert.throws(() => loadAutoNewsConfig({ AUTO_NEWS_CLOUDINARY_FOLDER: '../x' }), /AUTO_NEWS_CLOUDINARY_FOLDER/);
  assert.throws(() => loadAutoNewsConfig({ AUTO_NEWS_AUTO_PUBLISH: 'maybe' }), /true or false/);
});

test('trusted DKIM domains are exact and gappssmtp.com entries must belong to the sender domain', () => {
  assert.deepEqual(loadAutoNewsConfig({}).trustedDkimDomains, []);
  assert.deepEqual(
    loadAutoNewsConfig({ AUTO_NEWS_TRUSTED_DKIM_DOMAINS: ' ZenithWaveCapital-com.20251104.gappssmtp.com ' }).trustedDkimDomains,
    ['zenithwavecapital-com.20251104.gappssmtp.com'],
  );
  assert.throws(() => loadAutoNewsConfig({ AUTO_NEWS_TRUSTED_DKIM_DOMAINS: '*.gappssmtp.com' }), /exact domain names/);
  assert.throws(() => loadAutoNewsConfig({ AUTO_NEWS_TRUSTED_DKIM_DOMAINS: 'gappssmtp.com' }), /Google Workspace key domain/);
  assert.throws(() => loadAutoNewsConfig({ AUTO_NEWS_TRUSTED_DKIM_DOMAINS: 'attacker-com.20251104.gappssmtp.com' }), /Google Workspace key domain/);
});
