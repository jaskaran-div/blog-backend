import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExcerpt,
  createSlug,
  extractEmailContent,
  extractImageUrls,
  extractLinks,
  findReferencedContentIds,
  htmlToText,
  isAuthenticatedSender,
  replaceCidReferences,
  sanitizeNewsHtml,
  stripMailingListFooter,
  cleanTrackingLinks,
} from '../src/autoNewsEmail.js';
import { IMAGE_BYTES, SENDER, authResults, buildMessage } from './fixtures/gmailMessage.js';

test('extracts the exact subject, sender, date, HTML body and inline images', async () => {
  const message = buildMessage();
  const loaded = [];
  const content = await extractEmailContent(message, {
    async loadAttachment(id) {
      loaded.push(id);
      return IMAGE_BYTES;
    },
  });

  assert.equal(content.subject, 'Morning Briefing – Monday 26.10: Fed Week');
  assert.equal(content.from, SENDER);
  assert.equal(content.publishedAt.toISOString(), '2026-10-26T07:35:00.000Z');
  assert.match(content.html, /cid:image001\.png@01DB/);
  assert.equal(content.inlineImages.length, 1);
  assert.deepEqual(content.inlineImages[0].contentIds, ['image001.png@01db']);
  assert.deepEqual(await content.inlineImages[0].load(), IMAGE_BYTES);
  assert.deepEqual(loaded, ['att-1']);
});

test('falls back to the plain-text body as escaped paragraphs when there is no HTML part', async () => {
  const message = buildMessage({ imageParts: [] });
  message.payload.parts[0].parts.pop();
  message.payload.parts[0].parts[0].body.data = Buffer.from('Line <one>\n\nLine two').toString('base64url');

  const content = await extractEmailContent(message, { loadAttachment: async () => Buffer.alloc(0) });
  assert.equal(content.html, '<p>Line &lt;one&gt;</p>\n<p>Line two</p>');
});

test('decodes non UTF-8 charsets', async () => {
  const message = buildMessage({ imageParts: [] });
  const htmlPart = message.payload.parts[0].parts[1];
  htmlPart.headers = [{ name: 'Content-Type', value: 'text/html; charset=iso-8859-1' }];
  htmlPart.body.data = Buffer.from([0x3c, 0x70, 0x3e, 0xa3, 0x35, 0x3c, 0x2f, 0x70, 0x3e]).toString('base64url');

  const content = await extractEmailContent(message, { loadAttachment: async () => Buffer.alloc(0) });
  assert.equal(content.html, '<p>£5</p>');
});

test('replaces matching cid: references with HTTPS URLs and leaves unknown ones', () => {
  const html = '<img src="cid:image001.png@01DB"><img src=\'cid:other\'><td style="background:url(cid:image001.png@01DB)">';
  const replaced = replaceCidReferences(html, new Map([['image001.png@01db', 'https://res.cloudinary.com/demo/a.png']]));

  assert.equal(
    replaced,
    '<img src="https://res.cloudinary.com/demo/a.png"><img src=\'cid:other\'><td style="background:url(https://res.cloudinary.com/demo/a.png)">',
  );
  assert.deepEqual([...findReferencedContentIds(html)], ['image001.png@01db', 'other']);
});

test('sanitizer keeps article formatting, links and images but removes active content', () => {
  const html = sanitizeNewsHtml(`<html><head><title>Hidden</title></head><body>
    <table width="600" cellpadding="4"><tr><td style="color:#333;padding:8px;position:fixed">
    <h2 class="x" id="y">Heading</h2><p onclick="x()">Body <strong>bold</strong></p>
    <a href="https://example.com/a?x=1&y=2">Link</a><a href="javascript:alert(1)">Bad</a>
    <img src="https://res.cloudinary.com/demo/a.png" alt="Chart" width="600">
    <img src="cid:missing"><img src="data:image/png;base64,AAAA"><img src="https://t.example/p.gif" width="1" height="1">
    <div style="background:url(https://evil.example/x.png);color:red">Styled</div>
    <script>alert(1)</script><style>p{}</style><iframe src="https://evil.example"></iframe>
    </td></tr></table></body></html>`);

  assert.match(html, /<table width="600" cellpadding="4">/);
  assert.match(html, /<td style="color:#333;padding:8px">/);
  assert.match(html, /<h2>Heading<\/h2>/);
  assert.match(html, /<p>Body <strong>bold<\/strong><\/p>/);
  assert.match(html, /<a href="https:\/\/example.com\/a\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">Link<\/a>/);
  assert.match(html, /<a target="_blank" rel="noopener noreferrer">Bad<\/a>/);
  assert.match(html, /<img src="https:\/\/res.cloudinary.com\/demo\/a.png" alt="Chart" width="600" loading="lazy" \/>/);
  assert.match(html, /<div style="color:red">Styled<\/div>/);
  assert.doesNotMatch(html, /script|iframe|onclick|javascript:|cid:|data:image|t\.example|evil|Hidden|class=|id=/);
  assert.deepEqual(extractLinks(html), ['https://example.com/a?x=1&y=2']);
  assert.deepEqual(extractImageUrls(html), ['https://res.cloudinary.com/demo/a.png']);
});

test('only Gmail-added DKIM or DMARC results for the sender domain authenticate the sender', () => {
  const withHeader = (value) => ({ headers: [{ name: 'Authentication-Results', value }] });

  assert.equal(isAuthenticatedSender(withHeader(authResults()), SENDER), true);
  assert.equal(isAuthenticatedSender(
    withHeader('mx.google.com; dkim=fail header.i=@zenithwavecapital.com; dmarc=fail header.from=zenithwavecapital.com'),
    SENDER,
  ), false);
  assert.equal(isAuthenticatedSender(withHeader(authResults('attacker.example')), SENDER), false);
  assert.equal(isAuthenticatedSender(withHeader(authResults('zenithwavecapital.com', 'forged.example')), SENDER), false);
  assert.equal(isAuthenticatedSender(withHeader(authResults('zenithwavecapital.com.evil.example')), SENDER), false);
  assert.equal(isAuthenticatedSender({ headers: [] }, SENDER), false);
});

test('slugs are URL-safe, deterministic per message and distinct across messages', () => {
  const first = createSlug('Morning Briefing – Monday 26.10: Fed Week', 'msg0001');

  assert.match(first, /^morning-briefing-monday-26-10-fed-week-[0-9a-f]{8}$/);
  assert.equal(createSlug('Morning Briefing – Monday 26.10: Fed Week', 'msg0001'), first);
  assert.notEqual(createSlug('Morning Briefing – Monday 26.10: Fed Week', 'msg0002'), first);
  assert.match(createSlug('!!!', 'msg0001'), /^news-[0-9a-f]{8}$/);
  const long = createSlug('word '.repeat(60), 'msg0001');
  assert.ok(long.length <= 110);
  assert.match(long, /^(word-)+[0-9a-f]{8}$/);
});

test('excerpt is plain text cut at a word boundary', () => {
  const text = htmlToText('<p>Markets&nbsp;<strong>rally</strong></p><p>ahead of the FOMC &amp; ECB.</p>');
  assert.equal(text, 'Markets rally ahead of the FOMC & ECB.');
  assert.equal(buildExcerpt('alpha beta gamma delta', 14), 'alpha beta…');
  assert.equal(buildExcerpt('short', 14), 'short');
});

// Headers shaped like the real 27 October Missive: signed only by the sender's Google Workspace
// default key domain, with SPF and DMARC failing for zenithwavecapital.com.
const WORKSPACE_DKIM = 'zenithwavecapital-com.20251104.gappssmtp.com';
function workspaceSigned({
  resultDomain = WORKSPACE_DKIM,
  signatureDomain = WORKSPACE_DKIM,
  signedHeaders = 'list-id:subject:date:from:mime-version:to',
  resultB = 'eUy8tjW+',
  signatureB = 'eUy8tjW+QmZ2restOfSignature==',
  authServer = 'mx.google.com',
  extraTopHeaders = [],
} = {}) {
  return {
    headers: [
      ...extraTopHeaders,
      { name: 'ARC-Authentication-Results', value: `i=4; mx.google.com; dkim=pass header.i=@${resultDomain}` },
      {
        name: 'Authentication-Results',
        value: `${authServer}; dkim=pass header.i=@${resultDomain} header.s=20251104 header.b=${resultB}; arc=pass (i=3 dkim=pass dkdomain=${resultDomain}); spf=fail (google.com: domain of x@zenithwavecapital.com does not designate 209.85.220.77 as permitted sender) smtp.mailfrom=x@zenithwavecapital.com`,
      },
      {
        name: 'DKIM-Signature',
        value: `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${signatureDomain}; s=20251104; t=1793081183; h=${signedHeaders}; bh=abc=; b=${signatureB}`,
      },
      { name: 'From', value: `Neil Crammond <${SENDER}>` },
    ],
  };
}
const trusted = { trustedDkimDomains: [WORKSPACE_DKIM] };

test('accepts the exact configured Google Workspace DKIM domain when its signature covers From', () => {
  assert.equal(isAuthenticatedSender(workspaceSigned(), SENDER, trusted), true);
});

test('Workspace DKIM is rejected unless that exact domain is configured', () => {
  assert.equal(isAuthenticatedSender(workspaceSigned(), SENDER), false, 'not configured');
  assert.equal(isAuthenticatedSender(workspaceSigned(), SENDER, { trustedDkimDomains: ['other-com.1.gappssmtp.com'] }), false);
  const otherKey = 'zenithwavecapital-com.20990101.gappssmtp.com';
  assert.equal(isAuthenticatedSender(workspaceSigned({ resultDomain: otherKey, signatureDomain: otherKey }), SENDER, trusted), false);
  const attacker = 'attacker-example.20251104.gappssmtp.com';
  assert.equal(isAuthenticatedSender(workspaceSigned({ resultDomain: attacker, signatureDomain: attacker }), SENDER, trusted), false);
});

test('Workspace DKIM requires a matching signature that signed the From header', () => {
  assert.equal(isAuthenticatedSender(workspaceSigned({ signedHeaders: 'subject:date:to' }), SENDER, trusted), false, 'From not signed');
  assert.equal(isAuthenticatedSender(workspaceSigned({ signatureB: 'ZZZZZZZZother' }), SENDER, trusted), false, 'different signature');
  assert.equal(isAuthenticatedSender(workspaceSigned({ signatureDomain: 'attacker.example' }), SENDER, trusted), false, 'different d=');
  assert.equal(isAuthenticatedSender(workspaceSigned({ resultB: 'eUy' }), SENDER, trusted), false, 'too-short b= prefix');
});

test('trusted DKIM domain does not help a different sender', () => {
  assert.equal(isAuthenticatedSender(workspaceSigned(), 'someone@example.com', trusted), false);
});

test('missing or untrusted authentication results fail closed', () => {
  const noResults = workspaceSigned();
  noResults.headers = noResults.headers.filter((header) => header.name !== 'Authentication-Results');
  assert.equal(isAuthenticatedSender(noResults, SENDER, trusted), false, 'missing');
  assert.equal(isAuthenticatedSender(workspaceSigned({ authServer: 'forged.example' }), SENDER, trusted), false, 'other authserv-id');
});

test('only the topmost (Gmail-added) Authentication-Results header is trusted', () => {
  // A failing Gmail result on top, with a forged passing "mx.google.com" result injected below it.
  const forged = workspaceSigned();
  forged.headers.unshift({ name: 'Authentication-Results', value: 'mx.google.com; dkim=none; spf=fail; dmarc=fail header.from=zenithwavecapital.com' });
  assert.equal(isAuthenticatedSender(forged, SENDER, trusted), false);
  assert.equal(isAuthenticatedSender({
    headers: [
      { name: 'Authentication-Results', value: 'mx.google.com; spf=fail; dmarc=fail header.from=zenithwavecapital.com' },
      { name: 'Authentication-Results', value: authResults() },
    ],
  }, SENDER), false);
});

test('strips the Google Groups footer, keeping the article', () => {
  const html = sanitizeNewsHtml('<div><p>Article end</p><p></p>\n\n-- <br />\nYou received this message because you are subscribed to the Google Groups "Morning-Missive" group.<br />\n'
    + 'To unsubscribe from this group and stop receiving emails from it, send an email to <a href="mailto:morning-missive+unsubscribe@zenithwavecapital.com">x</a>.<br />\n'
    + 'For more options, visit <a href="https://groups.google.com/a/zenithwavecapital.com/d/optout">opt out</a>.<br /></div>');
  const stripped = stripMailingListFooter(html);

  assert.match(stripped, /<p>Article end<\/p>/);
  assert.doesNotMatch(stripped, /Google Groups|unsubscribe|optout|-- /);
  assert.match(stripped, /<\/div>$/, 'open elements are closed again');
  assert.equal(stripMailingListFooter('<p>No footer</p>'), '<p>No footer</p>');
});

test('unwraps safelinks, resolves AWeber trackers, drops utm params and unresolvable trackers', async () => {
  const aweber = (id) => `https://clicks.aweber.com/y/ct/?l=EEgLZ&m=hm&b=${id}`;
  const safe = (target) => `https://emea01.safelinks.protection.outlook.com/?url=${encodeURIComponent(target)}&amp;data=05%7C02&amp;reserved=0`;
  const html = [
    `<a href="${safe(aweber('ok'))}" target="_blank">FT</a>`,
    `<a href="${safe(aweber('dead'))}" target="_blank">Dead</a>`,
    `<a href="${safe('https://example.com/report?utm_source=x&id=7')}">Direct</a>`,
    '<a href="mailto:neil@example.com">Mail</a>',
    `<a href="${safe('javascript:alert(1)')}">Bad</a>`,
  ].join('');
  const resolved = [];
  const cleaned = await cleanTrackingLinks(html, {
    async resolveRedirect(url) {
      resolved.push(url);
      return url.endsWith('b=ok') ? 'https://www.ft.com/content/abc?utm_medium=email' : null;
    },
  });

  assert.equal(cleaned, '<a href="https://www.ft.com/content/abc" target="_blank">FT</a>'
    + '<a target="_blank">Dead</a>'
    + '<a href="https://example.com/report?id=7">Direct</a>'
    + '<a href="mailto:neil@example.com">Mail</a>'
    + '<a>Bad</a>');
  assert.deepEqual(resolved.sort(), [aweber('dead'), aweber('ok')]);
});

test('drops Outlook "Protected by Outlook" tooltips that expose tracking URLs, keeps normal titles', () => {
  const html = sanitizeNewsHtml('<a href="https://ft.com/a" title="Protected by Outlook: https://clicks.aweber.com/y/ct/?l=1. Click or tap to follow the link.">FT</a><a href="https://ft.com/b" title="Read more">B</a>');
  assert.doesNotMatch(html, /aweber|Protected by Outlook/);
  assert.match(html, /<a href="https:\/\/ft.com\/b" title="Read more"/);
});
