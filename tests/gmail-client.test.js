import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudinaryUploader } from '../src/cloudinaryUploader.js';
import { createGmailClient } from '../src/gmailClient.js';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('Gmail client refreshes the OAuth token once and reads messages read-only', async () => {
  const requests = [];
  const client = createGmailClient(
    { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', user: 'me' },
    {
      async fetchImpl(url, options = {}) {
        requests.push({ url: String(url), options });
        if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
          return jsonResponse(200, { access_token: 'access-1', expires_in: 3600 });
        }
        if (String(url).includes('/attachments/')) {
          return jsonResponse(200, { data: Buffer.from('img').toString('base64url') });
        }
        if (String(url).includes('/messages/abc')) {
          return jsonResponse(200, { id: 'abc' });
        }
        return jsonResponse(200, { messages: [{ id: 'abc' }, { id: 'def' }] });
      },
    },
  );

  assert.deepEqual(await client.listMessageIds('from:a@b.com newer_than:3d', 25), ['abc', 'def']);
  assert.deepEqual(await client.getMessage('abc'), { id: 'abc' });
  assert.deepEqual(await client.getAttachment('abc', 'att'), Buffer.from('img'));

  const tokenRequests = requests.filter((request) => request.url.startsWith('https://oauth2.googleapis.com/token'));
  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0].options.body.get('grant_type'), 'refresh_token');
  const list = new URL(requests[1].url);
  assert.equal(list.pathname, '/gmail/v1/users/me/messages');
  assert.equal(list.searchParams.get('q'), 'from:a@b.com newer_than:3d');
  assert.equal(new URL(requests[2].url).searchParams.get('format'), 'full');
  assert.ok(requests.slice(1).every((request) => request.options.headers.Authorization === 'Bearer access-1'));
  assert.ok(requests.slice(1).every((request) => !request.options.method));
});

test('Gmail OAuth failures expose only a status code', async () => {
  const client = createGmailClient(
    { clientId: 'id', clientSecret: 'client-secret-value', refreshToken: 'refresh-token-value' },
    { fetchImpl: async () => jsonResponse(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) },
  );

  await assert.rejects(client.listMessageIds('q'), (error) => {
    assert.equal(error.code, 'GMAIL_OAUTH_INVALID_GRANT');
    assert.doesNotMatch(error.message, /secret-value|token-value|revoked/);
    return true;
  });
});

test('Cloudinary uploader uses a deterministic public ID without overwriting', async () => {
  const calls = [];
  const upload = createCloudinaryUploader(
    { cloudName: 'demo', apiKey: 'key', apiSecret: 'secret' },
    {
      client: {
        uploader: {
          async upload(file, options) {
            calls.push({ file, options });
            return { secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/derivion/auto-news/m/abc.png' };
          },
        },
      },
    },
  );

  const url = await upload({ buffer: Buffer.from('img'), mimeType: 'image/png', folder: 'derivion/auto-news', publicId: 'm/abc' });
  assert.equal(url, 'https://res.cloudinary.com/demo/image/upload/v1/derivion/auto-news/m/abc.png');
  assert.equal(calls[0].file, `data:image/png;base64,${Buffer.from('img').toString('base64')}`);
  assert.equal(calls[0].options.public_id, 'm/abc');
  assert.equal(calls[0].options.overwrite, false);
  assert.equal(calls[0].options.unique_filename, false);
  assert.equal(calls[0].options.cloud_name, 'demo');
});

test('Cloudinary uploader rejects non-HTTPS results', async () => {
  const upload = createCloudinaryUploader(
    { cloudName: 'demo', apiKey: 'key', apiSecret: 'secret' },
    { client: { uploader: { upload: async () => ({ url: 'http://insecure' }) } } },
  );
  await assert.rejects(upload({ buffer: Buffer.alloc(1), mimeType: 'image/png', folder: 'f', publicId: 'p' }), /secure image URL/);
});
