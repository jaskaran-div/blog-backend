import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutoNewsService } from '../src/autoNewsService.js';
import { loadAutoNewsConfig } from '../src/config.js';
import { IMAGE_BYTES, buildMessage } from './fixtures/gmailMessage.js';

// Monday 26 Oct 2026, 13:05 IST.
const IN_WINDOW = new Date('2026-10-26T07:35:00Z');

function createMemoryPool() {
  const rows = new Map();
  return {
    rows,
    async query(sql, params) {
      if (sql.includes('INSERT INTO automated_news_posts')) {
        const [messageId, sender, title, slug, excerpt, html, cover, images, links, publishedAt, status, lastError] = params;
        const existing = rows.get(messageId);
        if (existing && existing.status !== 'failed') {
          return { rows: [] };
        }
        const row = {
          gmail_message_id: messageId,
          sender,
          title,
          slug,
          excerpt,
          html_content: html,
          cover_image_url: cover,
          images: JSON.parse(images),
          links: JSON.parse(links),
          published_at: publishedAt,
          status,
          last_error: lastError,
          attempts: existing ? existing.attempts + 1 : 1,
        };
        rows.set(messageId, row);
        return { rows: [{ slug, status }] };
      }
      if (sql.includes('WHERE gmail_message_id = ANY')) {
        return { rows: [...rows.values()].filter((row) => params[0].includes(row.gmail_message_id)) };
      }
      if (sql.includes("WHERE status = 'published'")) {
        return { rows: [...rows.values()].filter((row) => row.status === 'published') };
      }
      if (sql.includes("WHERE slug = $1 AND status = 'published'")) {
        return { rows: [...rows.values()].filter((row) => row.slug === params[0] && row.status === 'published') };
      }
      if (sql.includes('SET status = $3')) {
        const row = [...rows.values()].find((candidate) => candidate.slug === params[0] && params[1].includes(candidate.status));
        if (!row) return { rows: [] };
        row.status = params[2];
        return { rows: [{ slug: row.slug, status: row.status }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

function createFakeGmail(messages) {
  const calls = { list: [], get: [], attachment: [] };
  return {
    calls,
    async listMessageIds(query) {
      calls.list.push(query);
      return messages.map((message) => message.id).reverse();
    },
    async getMessage(id) {
      calls.get.push(id);
      return structuredClone(messages.find((message) => message.id === id));
    },
    async getAttachment(messageId, attachmentId) {
      calls.attachment.push([messageId, attachmentId]);
      return IMAGE_BYTES;
    },
  };
}

function setup({ env = {}, messages = [buildMessage()], uploadImage, now = () => IN_WINDOW } = {}) {
  const pool = createMemoryPool();
  const gmail = createFakeGmail(messages);
  const uploads = [];
  const sleeps = [];
  const service = createAutoNewsService({
    pool,
    gmail,
    config: loadAutoNewsConfig(env),
    uploadImage: uploadImage ?? (async (options) => {
      uploads.push(options);
      return `https://res.cloudinary.com/demo/image/upload/derivion/auto-news/${options.publicId}.png`;
    }),
    logger: { info() {}, warn() {}, error() {} },
    sleep: async (ms) => { sleeps.push(ms); },
    now,
  });
  return { service, pool, gmail, uploads, sleeps };
}

test('imports a sender email as a draft with Cloudinary URLs in place of cid: images', async () => {
  const { service, pool, gmail, uploads } = setup();
  const result = await service.runImport();

  assert.equal(result.status, 'completed');
  assert.deepEqual(gmail.calls.list, ['from:neil.crammond@zenithwavecapital.com newer_than:3d']);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, 'draft');

  const row = pool.rows.get('msg0001');
  assert.equal(row.title, 'Morning Briefing – Monday 26.10: Fed Week');
  assert.equal(row.sender, 'neil.crammond@zenithwavecapital.com');
  assert.equal(row.status, 'draft');
  assert.equal(new Date(row.published_at).toISOString(), '2026-10-26T07:35:00.000Z');
  assert.match(row.slug, /^morning-briefing-monday-26-10-fed-week-[0-9a-f]{8}$/);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].folder, 'derivion/auto-news');
  assert.equal(uploads[0].mimeType, 'image/png');
  assert.deepEqual(uploads[0].buffer, IMAGE_BYTES);
  const imageUrl = `https://res.cloudinary.com/demo/image/upload/derivion/auto-news/${uploads[0].publicId}.png`;
  assert.match(row.html_content, new RegExp(`<img src="${imageUrl.replace(/[.\/]/g, '\\$&')}" alt="Chart"`));
  assert.doesNotMatch(row.html_content, /cid:|<script|onclick|<title|<style/);
  assert.equal(row.cover_image_url, imageUrl);
  assert.deepEqual(row.images, [imageUrl]);
  assert.deepEqual(row.links, ['https://example.com/report']);
  assert.equal(row.excerpt, 'Fed Week Markets rally ahead of the FOMC & ECB. Full report');

  // Drafts are not public.
  assert.deepEqual(await service.listPublished(), []);
  assert.equal(await service.getPublished(row.slug), null);
});

test('never imports the same Gmail message twice', async () => {
  const { service, pool, gmail, uploads } = setup();
  await service.runImport();
  const second = await service.runImport();

  assert.deepEqual(second.results.map(({ status, storedStatus }) => [status, storedStatus]), [['already-imported', 'draft']]);
  assert.deepEqual(gmail.calls.get, ['msg0001']);
  assert.equal(uploads.length, 1);
  assert.equal(pool.rows.size, 1);
});

test('publishes immediately only when AUTO_NEWS_AUTO_PUBLISH is true', async () => {
  const { service, pool } = setup({ env: { AUTO_NEWS_AUTO_PUBLISH: 'true' } });
  await service.runImport();
  const row = pool.rows.get('msg0001');

  assert.equal(row.status, 'published');
  const [post] = await service.listPublished();
  assert.equal(post.slug, row.slug);
  assert.equal(post.html, undefined);
  const detail = await service.getPublished(row.slug);
  assert.equal(detail.html, row.html_content);
  assert.equal(detail.publishedAt, '2026-10-26T07:35:00.000Z');
});

test('a draft can be published after review', async () => {
  const { service, pool } = setup();
  await service.runImport();
  const { slug } = pool.rows.get('msg0001');

  assert.deepEqual(await service.setStatus(slug, ['draft'], 'published'), { slug, status: 'published' });
  assert.equal((await service.listPublished()).length, 1);
});

test('Cloudinary failures are retried, recorded as failed, and later re-imported without duplicates', async () => {
  let failUploads = true;
  const publicIds = [];
  const { service, pool, sleeps } = setup({
    uploadImage: async ({ publicId }) => {
      publicIds.push(publicId);
      if (failUploads) throw new Error('Cloudinary 500');
      return `https://res.cloudinary.com/demo/image/upload/${publicId}.png`;
    },
  });

  const first = await service.runImport();
  assert.equal(first.results[0].status, 'failed');
  assert.equal(publicIds.length, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
  let row = pool.rows.get('msg0001');
  assert.equal(row.status, 'failed');
  assert.match(row.last_error, /Cloudinary upload failed: Cloudinary 500/);
  assert.equal(row.html_content, '');

  failUploads = false;
  const second = await service.runImport();
  assert.equal(second.results[0].status, 'draft');
  row = pool.rows.get('msg0001');
  assert.equal(pool.rows.size, 1);
  assert.equal(row.attempts, 2);
  assert.equal(row.last_error, null);
  assert.equal(new Set(publicIds).size, 1, 'retries reuse one deterministic Cloudinary public ID');
});

test('failed imports stop retrying after AUTO_NEWS_MAX_ATTEMPTS', async () => {
  const { service, gmail } = setup({
    env: { AUTO_NEWS_MAX_ATTEMPTS: '2' },
    uploadImage: async () => { throw new Error('down'); },
  });
  await service.runImport();
  await service.runImport();
  await service.runImport();

  assert.equal(gmail.calls.get.length, 2);
});

test('rejects other senders and spoofed From headers without publishing them', async () => {
  const { service, pool, uploads } = setup({
    env: { AUTO_NEWS_AUTO_PUBLISH: 'true' },
    messages: [
      buildMessage({ id: 'other', from: 'Someone <someone@example.com>' }),
      buildMessage({ id: 'spoofed', extraHeaders: [] }),
      buildMessage({
        id: 'forged',
        extraHeaders: [{ name: 'Authentication-Results', value: 'evil.example; dkim=pass header.i=@zenithwavecapital.com' }],
      }),
    ],
  });
  const result = await service.runImport();

  assert.deepEqual(result.results.map((item) => item.status), ['rejected', 'rejected', 'rejected']);
  assert.equal(uploads.length, 0);
  assert.ok([...pool.rows.values()].every((row) => row.status === 'rejected' && row.html_content === ''));
  assert.deepEqual(await service.listPublished(), []);
});

test('sender authentication can be relaxed explicitly', async () => {
  const { service } = setup({
    env: { AUTO_NEWS_REQUIRE_SENDER_AUTH: 'false' },
    messages: [buildMessage({ extraHeaders: [] })],
  });
  assert.equal((await service.runImport()).results[0].status, 'draft');
});

test('dry run reports parsed content without uploading or saving', async () => {
  const { service, pool, uploads } = setup({
    messages: [buildMessage({ html: '<p>Hi</p><img src="cid:image001.png@01DB"><img src="cid:nope">' })],
  });
  const { results: [result] } = await service.runImport({ dryRun: true });

  assert.equal(result.status, 'dry-run');
  assert.equal(result.title, 'Morning Briefing – Monday 26.10: Fed Week');
  assert.deepEqual(result.inlineImages.map((image) => image.filename), ['image001.png']);
  assert.deepEqual(result.unmatchedCidReferences, ['nope']);
  assert.equal(uploads.length, 0);
  assert.equal(pool.rows.size, 0);
});

test('one malformed message does not stop the rest of the run', async () => {
  const good = buildMessage({ id: 'good' });
  const { service, gmail } = setup({ messages: [buildMessage({ id: 'bad' }), good] });
  const getMessage = gmail.getMessage;
  gmail.getMessage = async (id) => {
    if (id === 'bad') throw Object.assign(new Error('Gmail API request failed with status 500.'), { code: 'GMAIL_ERROR' });
    return getMessage(id);
  };

  const { results } = await service.runImport();
  assert.deepEqual(results.map((item) => [item.messageId, item.status]), [['bad', 'error'], ['good', 'draft']]);
});

test('checks run only 13:00-13:59 and 16:00-16:59 IST, Sunday to Friday', () => {
  const { service } = setup();
  const at = (iso) => service.isWithinImportWindow(new Date(iso));

  assert.equal(at('2026-10-25T07:30:00Z'), true, 'Sunday 13:00 IST');
  assert.equal(at('2026-10-26T08:29:59Z'), true, 'Monday 13:59 IST');
  assert.equal(at('2026-10-26T08:30:00Z'), false, 'Monday 14:00 IST');
  assert.equal(at('2026-10-26T09:30:00Z'), false, 'Monday 15:00 IST');
  assert.equal(at('2026-10-30T10:30:00Z'), true, 'Friday 16:00 IST');
  assert.equal(at('2026-10-30T11:29:00Z'), true, 'Friday 16:59 IST');
  assert.equal(at('2026-10-30T11:30:00Z'), false, 'Friday 17:00 IST');
  assert.equal(at('2026-10-31T07:45:00Z'), false, 'Saturday 13:15 IST');
  assert.equal(at('2026-10-31T10:45:00Z'), false, 'Saturday 16:15 IST');
});

test('scheduled runs outside the window do not contact Gmail; forced runs do', async () => {
  const { service, gmail } = setup({ now: () => new Date('2026-10-31T07:45:00Z') });

  assert.deepEqual(await service.runImport(), { status: 'skipped', reason: 'outside-window', results: [] });
  assert.equal(gmail.calls.list.length, 0);
  await service.runImport({ force: true });
  assert.equal(gmail.calls.list.length, 1);
});

test('rejects malformed slugs before querying', async () => {
  const { service } = setup();
  assert.equal(await service.getPublished('../etc'), null);
  assert.equal(await service.getPublished('A'.repeat(10)), null);
});

// Mirrors the Weekend Missive: multipart/mixed > multipart/related > (multipart/alternative + two
// inline images). One image body is inline in the payload, the other needs the attachment endpoint.
function weekendMissive({ id = '1a1738562f2ca8ed' } = {}) {
  const b64 = (value) => Buffer.from(value).toString('base64url');
  const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xfb, 0xff]); // contains bytes that differ in base64 vs base64url
  return {
    message: {
      id,
      internalDate: String(Date.parse('2026-10-24T09:00:00Z')),
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: '"Neil Crammond" <neil.crammond@zenithwavecapital.com>' },
          { name: 'Subject', value: 'ZENITH WAVE CAPITAL WEEKEND MISSIVE' },
          { name: 'Date', value: 'Sat, 24 Oct 2026 14:30:00 +0530' },
          { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@zenithwavecapital.com; dmarc=pass header.from=zenithwavecapital.com' },
        ],
        parts: [{
          mimeType: 'multipart/related',
          headers: [],
          parts: [
            {
              mimeType: 'multipart/alternative',
              headers: [],
              parts: [
                { mimeType: 'text/plain', headers: [], body: { data: b64('plain') } },
                {
                  mimeType: 'text/html',
                  headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
                  body: { data: b64('<div dir="ltr"><p>WEEKEND <b>MISSIVE</b></p>'
                    + '<table><tr><td><img src="cid:ii_abc123" alt="image.png" width="500"></td></tr></table>'
                    + '<p><a href="https://zenithwavecapital.com">ZWC</a></p>'
                    + '<img src="cid:ii_def456" alt="5422.jpg"><p>End</p></div>') },
                },
              ],
            },
            {
              mimeType: 'image/png',
              filename: 'image.png',
              headers: [{ name: 'Content-ID', value: '<ii_abc123>' }, { name: 'X-Attachment-Id', value: 'ii_abc123' }],
              body: { attachmentId: 'ANGjdJ_big', size: 2048 },
            },
            {
              mimeType: 'image/jpeg',
              filename: '5422.jpg',
              headers: [{ name: 'Content-ID', value: '<ii_def456>' }],
              body: { data: jpgBytes.toString('base64url'), size: jpgBytes.length },
            },
          ],
        }],
      },
    },
    jpgBytes,
  };
}

test('Weekend Missive: nested parts, both inline images uploaded, cid: replaced in place', async () => {
  const { message, jpgBytes } = weekendMissive();
  const { service, pool, gmail, uploads } = setup({ messages: [message] });
  const { results: [result] } = await service.runImport({ messageId: '1a1738562f2ca8ed' });

  assert.equal(result.status, 'draft');
  assert.equal(gmail.calls.list.length, 0, 'a specific message ID skips the search');
  assert.deepEqual(gmail.calls.attachment, [['1a1738562f2ca8ed', 'ANGjdJ_big']], 'only the non-inline body is fetched');
  assert.deepEqual(uploads.map((upload) => upload.mimeType), ['image/png', 'image/jpeg']);
  assert.deepEqual(uploads[0].buffer, IMAGE_BYTES);
  assert.deepEqual(uploads[1].buffer, jpgBytes, 'base64url payload data is decoded byte-exactly');

  const row = pool.rows.get('1a1738562f2ca8ed');
  assert.equal(row.title, 'ZENITH WAVE CAPITAL WEEKEND MISSIVE');
  const [pngUrl, jpgUrl] = uploads.map((upload) => `https://res.cloudinary.com/demo/image/upload/derivion/auto-news/${upload.publicId}.png`);
  assert.equal(
    row.html_content,
    `<div dir="ltr"><p>WEEKEND <b>MISSIVE</b></p><table><tr><td><img src="${pngUrl}" alt="image.png" width="500" loading="lazy" /></td></tr></table>`
      + '<p><a href="https://zenithwavecapital.com" target="_blank" rel="noopener noreferrer">ZWC</a></p>'
      + `<img src="${jpgUrl}" alt="5422.jpg" loading="lazy" /><p>End</p></div>`,
  );
  assert.deepEqual(row.images, [pngUrl, jpgUrl]);
});

test('dry run for one message previews HTML and metadata, optionally uploads, and never writes', async () => {
  const { message } = weekendMissive();
  const { service, pool, uploads } = setup({ messages: [message] });

  const { results: [preview] } = await service.runImport({ messageId: message.id, dryRun: true });
  assert.equal(preview.status, 'dry-run');
  assert.equal(preview.wouldSaveAs, 'draft');
  assert.equal(preview.title, 'ZENITH WAVE CAPITAL WEEKEND MISSIVE');
  assert.equal(preview.inlineImageCount, 2);
  assert.deepEqual(preview.inlineImages.map((image) => image.filename), ['image.png', '5422.jpg']);
  assert.equal(preview.renderedImageCount, 0, 'without uploads, cid images cannot render');
  assert.equal(uploads.length, 0);

  const { results: [uploaded] } = await service.runImport({ messageId: message.id, dryRun: true, uploadImages: true });
  assert.equal(uploaded.uploadedImages.length, 2);
  assert.equal(uploaded.renderedImageCount, 2);
  assert.doesNotMatch(uploaded.html, /cid:/);
  assert.equal(pool.rows.size, 0, 'dry runs never insert');

  // Re-running the uploads reuses the same deterministic Cloudinary public IDs.
  assert.deepEqual(uploads.slice(0, 2).map((u) => u.publicId), uploaded.uploadedImages.map((_, i) => uploads[i].publicId));
});

test('rejects malformed message IDs', async () => {
  const { service } = setup();
  await assert.rejects(service.runImport({ messageId: '../x' }), (error) => error.statusCode === 400);
});
