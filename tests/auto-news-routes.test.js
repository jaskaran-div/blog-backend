import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createApp } from '../src/app.js';

const IMPORT_TOKEN = 'auto-news-import-token-with-at-least-32-bytes';
const config = {
  allowedOrigins: ['http://localhost:3000'],
  trustProxyHops: 0,
  autoNews: { enabled: true, importToken: IMPORT_TOKEN },
};
const post = {
  slug: 'morning-briefing-1a2b3c4d',
  title: 'Morning Briefing',
  excerpt: 'Markets rally.',
  coverImageUrl: null,
  publishedAt: '2026-10-26T07:35:00.000Z',
};
let listHealthy = true;
let importFails = false;
const importCalls = [];

const app = createApp({
  config,
  logger: { error() {}, info() {} },
  newsletterService: {},
  emailService: {},
  autoNewsService: {
    async listPublished() {
      if (!listHealthy) throw Object.assign(new Error('private database detail'), { code: '42P01' });
      return [post];
    },
    async getPublished(slug) {
      return slug === post.slug ? { ...post, html: '<p>Markets rally.</p>' } : null;
    },
  },
  async runAutoNewsImport(options) {
    importCalls.push(options);
    if (importFails) throw Object.assign(new Error('secret detail'), { code: 'GMAIL_OAUTH_INVALID_GRANT' });
    return { status: 'completed', checked: 0, results: [] };
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

test('lists published automated news with short public caching', async () => {
  const response = await fetch(`${baseUrl}/api/auto-news/posts`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
  assert.deepEqual(await response.json(), { posts: [post] });
});

test('hides database errors from the public list', async () => {
  listHealthy = false;
  try {
    const response = await fetch(`${baseUrl}/api/auto-news/posts`);
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.deepEqual(body.posts, []);
    assert.doesNotMatch(JSON.stringify(body), /private database detail|42P01/);
  } finally {
    listHealthy = true;
  }
});

test('returns one published post with its HTML, or 404', async () => {
  const found = await fetch(`${baseUrl}/api/auto-news/posts/${post.slug}`);
  assert.equal(found.status, 200);
  assert.equal((await found.json()).post.html, '<p>Markets rally.</p>');

  const missing = await fetch(`${baseUrl}/api/auto-news/posts/unknown-slug`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
});

test('import requires the bearer token', async () => {
  for (const headers of [{}, { Authorization: 'Bearer wrong-token' }, { Authorization: IMPORT_TOKEN }]) {
    const response = await fetch(`${baseUrl}/api/auto-news/import`, { method: 'POST', headers });
    assert.equal(response.status, 401);
  }
  assert.equal(importCalls.length, 0);
});

test('authorized import runs a manual check and only forces the window when asked', async () => {
  const response = await fetch(`${baseUrl}/api/auto-news/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${IMPORT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: true }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(importCalls.at(-1), { trigger: 'manual', force: true, dryRun: false, uploadImages: false });

  await fetch(`${baseUrl}/api/auto-news/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${IMPORT_TOKEN}` },
  });
  assert.deepEqual(importCalls.at(-1), { trigger: 'manual', force: false, dryRun: false, uploadImages: false });
});

test('import failures return only a safe error code', async () => {
  importFails = true;
  try {
    const response = await fetch(`${baseUrl}/api/auto-news/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${IMPORT_TOKEN}` },
    });
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.code, 'GMAIL_OAUTH_INVALID_GRANT');
    assert.doesNotMatch(JSON.stringify(body), /secret detail/);
  } finally {
    importFails = false;
  }
});

test('import is unavailable while automated news is disabled', async () => {
  config.autoNews.enabled = false;
  try {
    const response = await fetch(`${baseUrl}/api/auto-news/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${IMPORT_TOKEN}` },
    });
    assert.equal(response.status, 503);
  } finally {
    config.autoNews.enabled = true;
  }
});

test('import endpoint passes dry-run, message ID and upload options through', async () => {
  const response = await fetch(`${baseUrl}/api/auto-news/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${IMPORT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: true, uploadImages: true, messageId: '1a1738562f2ca8ed' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(importCalls.at(-1), {
    trigger: 'manual', force: false, dryRun: true, uploadImages: true, messageId: '1a1738562f2ca8ed',
  });
});
