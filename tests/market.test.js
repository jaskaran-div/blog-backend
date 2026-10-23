import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createApp } from '../src/app.js';

const config = { allowedOrigins: ['http://localhost:3000'], trustProxyHops: 0 };
let snapshotHealthy = true;
let snapshotReads = 0;
const snapshot = {
  status: 'ok',
  realtime: false,
  snapshotUpdatedAt: '2026-10-23T03:30:00.000Z',
  staleAfterHours: 36,
  lastRun: null,
  instruments: [{ id: 'UST2Y', name: '2Y Treasury Yield', value: 4.79, dataDate: '2026-10-20', status: 'ok' }],
};

const app = createApp({
  config,
  logger: { error() {}, info() {} },
  newsletterService: {},
  emailService: {},
  marketSnapshotService: {
    async getLatestSnapshot() {
      snapshotReads += 1;
      if (!snapshotHealthy) {
        throw Object.assign(new Error('private database detail'), { code: '42P01' });
      }
      return snapshot;
    },
    async refresh() {
      throw new Error('The read endpoint must never trigger a refresh.');
    },
  },
});
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('market snapshot endpoint returns the stored snapshot with short public caching', async () => {
  const response = await fetch(`${baseUrl}/api/market/snapshot`, { headers: { Origin: 'http://localhost:3000' } });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.deepEqual(await response.json(), snapshot);
  assert.equal(snapshotReads, 1);
});

test('market snapshot endpoint hides database errors and reports unavailable', async () => {
  snapshotHealthy = false;
  try {
    const response = await fetch(`${baseUrl}/api/market/snapshot`);
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(body.status, 'unavailable');
    assert.deepEqual(body.instruments, []);
    assert.doesNotMatch(JSON.stringify(body), /private database detail|42P01/);
  } finally {
    snapshotHealthy = true;
  }
});

test('market snapshot endpoint is read-only', async () => {
  const response = await fetch(`${baseUrl}/api/market/snapshot`, { method: 'POST' });
  assert.equal(response.status, 404);
});
