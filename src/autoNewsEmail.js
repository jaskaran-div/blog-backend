import { createHash } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';

export const MAX_NEWS_HTML_LENGTH = 2_000_000;
const EXCERPT_LENGTH = 240;

// Values may not load external resources (url()), run legacy expressions, or escape out of the declaration.
const SAFE_STYLE_VALUE = /^(?!.*(?:url\s*\(|expression\s*\(|javascript:|@import|\\))[^<>{};]*$/i;
const ALLOWED_STYLE_PROPERTIES = [
  'color', 'background', 'background-color', 'text-align', 'font-family', 'font-size', 'font-weight',
  'font-style', 'line-height', 'letter-spacing', 'text-decoration', 'text-transform', 'white-space',
  'word-break', 'vertical-align', 'display', 'float', 'width', 'min-width', 'max-width', 'height',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-style',
  'border-width', 'border-radius', 'border-collapse', 'border-spacing',
];
const TABLE_CELL_ATTRIBUTES = ['colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'bgcolor'];

const SANITIZE_OPTIONS = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'center', 'font'],
  // No class or id attributes, so email markup cannot pick up or clash with site styles.
  allowedAttributes: {
    a: ['href', 'name', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    table: ['width', 'align', 'border', 'cellpadding', 'cellspacing', 'bgcolor', 'role'],
    tr: ['align', 'valign', 'bgcolor'],
    td: TABLE_CELL_ATTRIBUTES,
    th: TABLE_CELL_ATTRIBUTES,
    col: ['span', 'width'],
    colgroup: ['span', 'width'],
    font: ['color', 'size', 'face'],
    '*': ['style', 'align', 'dir', 'lang'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  // Unresolved cid: images and data: URIs are dropped rather than rendered broken.
  allowedSchemesByTag: { img: ['https', 'http'] },
  allowProtocolRelative: false,
  allowedStyles: {
    '*': Object.fromEntries(ALLOWED_STYLE_PROPERTIES.map((property) => [property, [SAFE_STYLE_VALUE]])),
  },
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'head'],
  transformTags: {
    a: (tagName, { title, ...attribs }) => ({
      tagName,
      // Outlook's "Protected by Outlook: <tracking URL>" tooltip would expose the tracker; drop it.
      attribs: {
        ...attribs,
        ...(title && !/^Protected by Outlook:/i.test(title) ? { title } : {}),
        target: '_blank',
        rel: 'noopener noreferrer',
      },
    }),
    img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, loading: 'lazy' } }),
  },
  // Drop images whose source was removed, and 1x1 tracking pixels.
  exclusiveFilter: (frame) => frame.tag === 'img' && (
    !frame.attribs.src
    || (['0', '1'].includes(String(frame.attribs.width ?? '').replace(/px$/i, ''))
      && ['0', '1'].includes(String(frame.attribs.height ?? '').replace(/px$/i, '')))
  ),
};

export function sanitizeNewsHtml(html) {
  return sanitizeHtml(html, SANITIZE_OPTIONS).trim();
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function headerList(payload) {
  return Array.isArray(payload?.headers) ? payload.headers : [];
}

export function getHeader(payload, name) {
  const lower = name.toLowerCase();
  return headerList(payload).find((header) => header.name?.toLowerCase() === lower)?.value ?? '';
}

export function parseAddress(value) {
  const match = String(value).match(/<([^<>\s]+@[^<>\s]+)>\s*$/);
  return (match ? match[1] : String(value).trim()).toLowerCase();
}

/**
 * Trusts only the Authentication-Results header Gmail itself adds (authserv-id mx.google.com),
 * since a sender can include forged copies of the header in the message.
 */
export function isAuthenticatedSender(payload, sender, { trustedDkimDomains = [] } = {}) {
  const domain = sender.split('@')[1].toLowerCase();
  const headers = headerList(payload);
  // Gmail prepends its own result, so only the topmost Authentication-Results header is trusted.
  // Anything below it arrived with the message and may be forged.
  const topmost = headers.find((header) => header.name?.toLowerCase() === 'authentication-results');
  const value = String(topmost?.value ?? '');
  if (!/^\s*mx\.google\.com\s*;/i.test(value)) return false;

  const clauses = value.split(';').map((clause) => clause.trim());
  const property = (clause, name) => clause.match(new RegExp(`(?:^|\\s)header\\.${name}=([^\\s;()]+)`, 'i'))?.[1]?.toLowerCase();

  if (clauses.some((clause) => /^dmarc=pass\b/i.test(clause) && property(clause, 'from') === domain)) {
    return true;
  }
  for (const clause of clauses.filter((candidate) => /^dkim=pass\b/i.test(candidate))) {
    const signingDomain = property(clause, 'd') ?? property(clause, 'i')?.split('@').pop();
    if (signingDomain === domain) return true;
    // An exact, operator-configured extra domain (e.g. the sender's Google Workspace default
    // gappssmtp.com key) also passes, but only if the passing signature itself covers From.
    if (signingDomain && trustedDkimDomains.includes(signingDomain)
      && isWorkspaceKeyDomainOf(signingDomain, domain)
      && signatureCoversFrom(headers, signingDomain, property(clause, 'b'))) {
      return true;
    }
  }
  return false;
}

/** True for <sender-domain-with-dashes>.<digits>.gappssmtp.com, Google Workspace's default key domain. */
function isWorkspaceKeyDomainOf(signingDomain, senderDomain) {
  const prefix = `${senderDomain.replace(/\./g, '-')}.`;
  return signingDomain.startsWith(prefix)
    && /^\d+\.gappssmtp\.com$/.test(signingDomain.slice(prefix.length));
}

/** Finds the DKIM-Signature Gmail verified (same d= and b= prefix) and checks it signed From. */
function signatureCoversFrom(headers, signingDomain, signaturePrefix) {
  if (!signaturePrefix || signaturePrefix.length < 8) return false;
  return headers
    .filter((header) => header.name?.toLowerCase() === 'dkim-signature')
    .map((header) => String(header.value).replace(/\s+/g, ''))
    .some((signature) => {
      const tags = Object.fromEntries(signature.split(';').filter(Boolean).map((tag) => {
        const index = tag.indexOf('=');
        return [tag.slice(0, index).toLowerCase(), tag.slice(index + 1)];
      }));
      return tags.d?.toLowerCase() === signingDomain
        && typeof tags.b === 'string'
        && tags.b.toLowerCase().startsWith(signaturePrefix)
        && (tags.h ?? '').toLowerCase().split(':').includes('from');
    });
}

function* walkParts(part) {
  if (!part) return;
  yield part;
  for (const child of part.parts ?? []) {
    yield* walkParts(child);
  }
}

function charsetOf(part) {
  const match = getHeader(part, 'Content-Type').match(/charset="?([\w-]+)"?/i);
  return match ? match[1].toLowerCase() : 'utf-8';
}

function decodeText(buffer, charset) {
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function normalizeContentId(value) {
  return String(value).trim().replace(/^<|>$/g, '').trim().toLowerCase();
}

function isAttachment(part) {
  return /^\s*attachment/i.test(getHeader(part, 'Content-Disposition'));
}

/**
 * Reads the subject, HTML body, publication date and inline images from a Gmail API
 * message in `format=full`. `loadAttachment(attachmentId)` fetches bodies Gmail stores separately.
 */
export async function extractEmailContent(message, { loadAttachment }) {
  const payload = message.payload ?? {};
  const partData = async (part) => (part.body?.attachmentId
    ? loadAttachment(part.body.attachmentId)
    : Buffer.from(part.body?.data ?? '', 'base64url'));

  const parts = [...walkParts(payload)];
  const htmlPart = parts.find((part) => part.mimeType === 'text/html' && !isAttachment(part));
  const textPart = parts.find((part) => part.mimeType === 'text/plain' && !isAttachment(part));

  let html = '';
  if (htmlPart) {
    html = decodeText(await partData(htmlPart), charsetOf(htmlPart));
  } else if (textPart) {
    const text = decodeText(await partData(textPart), charsetOf(textPart));
    html = text
      .split(/\r?\n\s*\r?\n/)
      .map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replace(/\r?\n/g, '<br>')}</p>`)
      .join('\n');
  }

  const inlineImages = [];
  for (const part of parts) {
    if (!part.mimeType?.toLowerCase().startsWith('image/') || part === payload) continue;
    const contentIds = [getHeader(part, 'Content-ID'), getHeader(part, 'X-Attachment-Id')]
      .map(normalizeContentId)
      .filter(Boolean);
    if (contentIds.length === 0) continue;
    inlineImages.push({
      contentIds: [...new Set(contentIds)],
      mimeType: part.mimeType.toLowerCase(),
      filename: part.filename || '',
      load: () => partData(part),
    });
  }

  const dateHeader = Date.parse(getHeader(payload, 'Date'));
  const internalDate = Number(message.internalDate);
  const publishedAt = new Date(Number.isFinite(dateHeader)
    ? dateHeader
    : Number.isFinite(internalDate) && internalDate > 0 ? internalDate : Date.now());

  return {
    subject: getHeader(payload, 'Subject').trim(),
    from: parseAddress(getHeader(payload, 'From')),
    html,
    publishedAt,
    inlineImages,
  };
}

/** Replaces cid: references (src, background and url() values) with uploaded HTTPS URLs. */
export function replaceCidReferences(html, urlsByContentId) {
  return html.replace(/(["'(]\s*)cid:([^"')\s>]+)/gi, (match, prefix, rawId) => {
    let id = rawId;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      // Keep the raw value when it is not valid percent-encoding.
    }
    const url = urlsByContentId.get(normalizeContentId(id));
    return url ? `${prefix}${url}` : match;
  });
}

export function findReferencedContentIds(html) {
  const ids = new Set();
  for (const match of html.matchAll(/cid:([^"')\s>]+)/gi)) {
    try {
      ids.add(normalizeContentId(decodeURIComponent(match[1])));
    } catch {
      ids.add(normalizeContentId(match[1]));
    }
  }
  return ids;
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

export function htmlToText(html) {
  const spaced = html.replace(/<br\s*\/?>|<\/(?:p|div|td|th|tr|li|h[1-6]|table|blockquote)\s*>/gi, ' $&');
  return decodeEntities(sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} }))
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildExcerpt(text, maxLength = EXCERPT_LENGTH) {
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - 1);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > maxLength / 2 ? cut.slice(0, boundary) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}

export function extractLinks(sanitizedHtml) {
  const links = [];
  for (const match of sanitizedHtml.matchAll(/<a\s[^>]*?href="([^"]+)"/gi)) {
    const href = decodeEntities(match[1]);
    if (!links.includes(href)) links.push(href);
  }
  return links;
}

export function extractImageUrls(sanitizedHtml) {
  const urls = [];
  for (const match of sanitizedHtml.matchAll(/<img\s[^>]*?src="([^"]+)"/gi)) {
    const src = decodeEntities(match[1]);
    if (!urls.includes(src)) urls.push(src);
  }
  return urls;
}

/** Deterministic per message, so a retried import always produces the same slug. */
export function createSlug(subject, messageId) {
  let base = subject
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length > 100) {
    // Cut at a word boundary so slugs never end in half a word.
    base = base.slice(0, 101).replace(/-[^-]*$/, '');
  }
  const suffix = createHash('sha256').update(messageId).digest('hex').slice(0, 8);
  return `${base || 'news'}-${suffix}`;
}

export function cloudinaryPublicId(messageId, contentId) {
  const hash = createHash('sha256').update(`${messageId}:${contentId}`).digest('hex').slice(0, 24);
  return `${messageId.replace(/[^A-Za-z0-9_-]/g, '')}/${hash}`;
}

const MAILING_LIST_FOOTER = /(?:--\s*<br\s*\/?>\s*)?You received this message because you are subscribed to the Google Groups[\s\S]*$/i;

/** Removes the Google Groups footer (unsubscribe/opt-out links) that the list appends to every email. */
export function stripMailingListFooter(sanitizedHtml) {
  const stripped = sanitizedHtml.replace(MAILING_LIST_FOOTER, '');
  // Re-sanitizing closes any elements the cut left open.
  return stripped === sanitizedHtml ? sanitizedHtml : sanitizeNewsHtml(stripped);
}

const TRACKING_HOSTS = [/(^|\.)clicks\.aweber\.com$/i];

function unwrapSafeLink(url) {
  if (!/(^|\.)safelinks\.protection\.outlook\.com$/i.test(url.hostname)) return url;
  try {
    return new URL(url.searchParams.get('url') ?? '');
  } catch {
    return null;
  }
}

function withoutUtm(url) {
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key)) url.searchParams.delete(key);
  }
  return url;
}

/**
 * Rewrites links for public pages: unwraps Outlook safelinks, resolves known click trackers to their
 * destination with `resolveRedirect(url) -> string | null`, and drops utm_* parameters. A link that
 * cannot be made clean loses its href but keeps its text.
 */
export async function cleanTrackingLinks(sanitizedHtml, { resolveRedirect }) {
  const hrefs = new Set([...sanitizedHtml.matchAll(/href="([^"]*)"/g)].map((match) => match[1]));
  const cleaned = new Map();
  await Promise.all([...hrefs].map(async (encoded) => {
    const raw = decodeEntities(encoded);
    if (/^mailto:/i.test(raw) || !/safelinks\.protection\.outlook\.com|clicks\.aweber\.com|[?&]utm_/i.test(raw)) {
      // Nothing to clean: keep the link exactly as written.
      cleaned.set(encoded, encoded);
      return;
    }
    let url;
    try {
      url = unwrapSafeLink(new URL(raw));
      if (url && TRACKING_HOSTS.some((host) => host.test(url.hostname))) {
        const destination = await resolveRedirect(url.href);
        url = destination ? unwrapSafeLink(new URL(destination)) : null;
      }
    } catch {
      url = null;
    }
    const safe = url && ['http:', 'https:'].includes(url.protocol)
      && !TRACKING_HOSTS.some((host) => host.test(url.hostname));
    cleaned.set(encoded, safe ? withoutUtm(url).href.replace(/&/g, '&amp;').replace(/"/g, '&quot;') : null);
  }));
  return sanitizedHtml.replace(/ href="([^"]*)"/g, (match, encoded) => {
    const value = cleaned.get(encoded);
    return value ? ` href="${value}"` : '';
  });
}
