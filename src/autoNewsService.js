import {
  MAX_NEWS_HTML_LENGTH,
  buildExcerpt,
  cleanTrackingLinks,
  cloudinaryPublicId,
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
} from './autoNewsEmail.js';

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const UPLOAD_ATTEMPTS = 3;
const MAX_MESSAGES_PER_RUN = 25;

class ImageUploadError extends Error {}

/** One redirect hop for a click-tracking link; returns the Location target or null. Never throws. */
export async function resolveTrackingRedirect(url, { fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const location = response.headers.get('location');
    return response.status >= 300 && response.status < 400 && location ? new URL(location, url).href : null;
  } catch {
    return null;
  }
}

function errorSummary(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 500);
}

function toPost(row, { includeHtml = false } = {}) {
  return {
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    coverImageUrl: row.cover_image_url ?? null,
    publishedAt: new Date(row.published_at).toISOString(),
    ...(includeHtml ? { html: row.html_content } : {}),
  };
}

export function createAutoNewsService({
  pool,
  config,
  gmail,
  uploadImage,
  logger = console,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date(),
  resolveRedirect = resolveTrackingRedirect,
}) {
  const weekdayHourFormat = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  });

  function isWithinImportWindow(date = now()) {
    const parts = Object.fromEntries(weekdayHourFormat.formatToParts(date).map((part) => [part.type, part.value]));
    return parts.weekday !== 'Sat' && config.windowHours.includes(Number(parts.hour));
  }

  async function uploadWithRetry(image, messageId, contentId) {
    let lastError;
    for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
      try {
        return await uploadImage({
          buffer: await image.load(),
          mimeType: image.mimeType,
          folder: config.cloudinaryFolder,
          publicId: cloudinaryPublicId(messageId, contentId),
        });
      } catch (error) {
        lastError = error;
        if (attempt < UPLOAD_ATTEMPTS) {
          await sleep(1000 * 2 ** (attempt - 1));
        }
      }
    }
    throw new ImageUploadError(`Cloudinary upload failed: ${errorSummary(lastError)}`);
  }

  async function saveRecord(record) {
    const { rows } = await pool.query(
      `INSERT INTO automated_news_posts (
         gmail_message_id, sender, title, slug, excerpt, html_content, cover_image_url,
         images, links, published_at, status, last_error
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)
       ON CONFLICT (gmail_message_id) DO UPDATE SET
         sender = EXCLUDED.sender,
         title = EXCLUDED.title,
         slug = EXCLUDED.slug,
         excerpt = EXCLUDED.excerpt,
         html_content = EXCLUDED.html_content,
         cover_image_url = EXCLUDED.cover_image_url,
         images = EXCLUDED.images,
         links = EXCLUDED.links,
         published_at = EXCLUDED.published_at,
         status = EXCLUDED.status,
         last_error = EXCLUDED.last_error,
         attempts = automated_news_posts.attempts + 1,
         updated_at = NOW()
       WHERE automated_news_posts.status = 'failed'
       RETURNING slug, status`,
      [
        record.messageId,
        record.sender,
        record.title,
        record.slug,
        record.excerpt ?? '',
        record.html ?? '',
        record.coverImageUrl ?? null,
        JSON.stringify(record.images ?? []),
        JSON.stringify(record.links ?? []),
        record.publishedAt,
        record.status,
        record.lastError ?? null,
      ],
    );
    // No row means another run already stored this message; the unique constraint kept it single.
    return rows[0] ?? { slug: record.slug, status: 'duplicate' };
  }

  async function importMessage(messageId, { dryRun, uploadImages = false }) {
    const message = await gmail.getMessage(messageId);
    const content = await extractEmailContent(message, {
      loadAttachment: (attachmentId) => gmail.getAttachment(messageId, attachmentId),
    });
    const title = content.subject || `News update ${content.publishedAt.toISOString().slice(0, 10)}`;
    const base = {
      messageId,
      sender: content.from.slice(0, 254) || 'unknown',
      title: title.slice(0, 998),
      slug: createSlug(title, messageId),
      publishedAt: content.publishedAt,
    };

    let rejection = null;
    if (content.from !== config.sender) {
      rejection = 'Sender does not match AUTO_NEWS_SENDER.';
    } else if (config.requireSenderAuth && !isAuthenticatedSender(message.payload, config.sender, {
      trustedDkimDomains: config.trustedDkimDomains ?? [],
    })) {
      rejection = 'Gmail did not report a DKIM or DMARC pass for the sender domain.';
    } else if (!content.html.trim()) {
      rejection = 'Email has no HTML or text body.';
    }
    if (rejection) {
      logger.warn('Automated news email rejected.', { messageId, reason: rejection });
      return dryRun
        ? { ...base, status: 'rejected', reason: rejection }
        : { ...(await saveRecord({ ...base, status: 'rejected', lastError: rejection })), reason: rejection };
    }

    const referenced = findReferencedContentIds(content.html);
    const inlineImages = content.inlineImages.filter((image) => image.contentIds.some((id) => referenced.has(id)));
    const unmatchedCidReferences = [...referenced].filter(
      (id) => !content.inlineImages.some((image) => image.contentIds.includes(id)),
    );
    // A dry run uploads only when asked; uploads are idempotent (fixed public IDs, no overwrite),
    // so a later real import reuses the same Cloudinary assets.
    const shouldUpload = !dryRun || uploadImages;
    const urlsByContentId = new Map();
    const uploadedImages = [];
    try {
      for (const image of shouldUpload ? inlineImages : []) {
        const url = await uploadWithRetry(image, messageId, image.contentIds[0]);
        for (const id of image.contentIds) urlsByContentId.set(id, url);
        uploadedImages.push({ filename: image.filename, contentId: image.contentIds[0], url });
      }
    } catch (error) {
      if (!(error instanceof ImageUploadError)) throw error;
      if (dryRun) {
        return { ...base, status: 'dry-run', uploadError: error.message, uploadedImages };
      }
      logger.error('Automated news image upload failed; the import will be retried.', { messageId });
      return { ...(await saveRecord({ ...base, status: 'failed', lastError: error.message })), reason: error.message };
    }

    // Public pages get no mailing-list footer and no tracking/redirect wrappers on links.
    const html = await cleanTrackingLinks(
      stripMailingListFooter(sanitizeNewsHtml(replaceCidReferences(content.html, urlsByContentId))),
      { resolveRedirect },
    );
    if (dryRun) {
      const images = extractImageUrls(html);
      return {
        ...base,
        status: 'dry-run',
        wouldSaveAs: config.autoPublish ? 'published' : 'draft',
        excerpt: buildExcerpt(htmlToText(html)),
        inlineImageCount: inlineImages.length,
        inlineImages: inlineImages.map((image) => ({ filename: image.filename, contentId: image.contentIds[0], mimeType: image.mimeType })),
        uploadedImages,
        unmatchedCidReferences,
        renderedImageCount: images.length,
        images,
        links: extractLinks(html),
        htmlLength: html.length,
        html,
      };
    }
    if (!html || html.length > MAX_NEWS_HTML_LENGTH) {
      const reason = html ? 'Sanitized HTML exceeds the size limit.' : 'Email has no publishable content after sanitizing.';
      return { ...(await saveRecord({ ...base, status: 'rejected', lastError: reason })), reason };
    }
    const images = extractImageUrls(html);
    const saved = await saveRecord({
      ...base,
      html,
      excerpt: buildExcerpt(htmlToText(html)),
      images,
      links: extractLinks(html),
      coverImageUrl: images.find((url) => url.startsWith('https://res.cloudinary.com/')) ?? null,
      status: config.autoPublish ? 'published' : 'draft',
    });
    logger.info('Automated news email imported.', { messageId, slug: saved.slug, status: saved.status });
    return saved;
  }

  return {
    isWithinImportWindow,

    async runImport({
      trigger = 'scheduled', dryRun = false, force = false, messageId, uploadImages = false,
    } = {}) {
      if (messageId !== undefined && !MESSAGE_ID_PATTERN.test(String(messageId))) {
        throw Object.assign(new Error('Invalid Gmail message ID.'), { code: 'INVALID_MESSAGE_ID', statusCode: 400 });
      }
      // A specific message is a deliberate operator request, so it skips the schedule window and search.
      if (!messageId && !force && !isWithinImportWindow()) {
        return { status: 'skipped', reason: 'outside-window', results: [] };
      }

      const query = `from:${config.sender} newer_than:${config.lookbackDays}d`;
      // Gmail lists newest first; import oldest first so publication order matches arrival.
      const messageIds = messageId
        ? [String(messageId)]
        : (await gmail.listMessageIds(query, MAX_MESSAGES_PER_RUN)).reverse();
      if (messageIds.length === 0) {
        return { status: 'completed', trigger, checked: 0, results: [] };
      }

      const { rows } = await pool.query(
        `SELECT gmail_message_id, slug, status, attempts
         FROM automated_news_posts
         WHERE gmail_message_id = ANY($1::text[])`,
        [messageIds],
      );
      const existing = new Map(rows.map((row) => [row.gmail_message_id, row]));

      const results = [];
      for (const id of messageIds) {
        const row = existing.get(id);
        if (row && (row.status !== 'failed' || row.attempts >= config.maxAttempts)) {
          // Dry runs still preview already-imported messages, but never write.
          if (!dryRun) {
            results.push({ messageId: id, slug: row.slug, status: 'already-imported', storedStatus: row.status });
            continue;
          }
        }
        try {
          results.push({ messageId: id, ...(await importMessage(id, { dryRun, uploadImages })) });
        } catch (error) {
          logger.error('Automated news email could not be processed.', {
            messageId: id,
            code: error?.code ?? 'UNKNOWN',
            message: errorSummary(error),
          });
          results.push({ messageId: id, status: 'error', reason: errorSummary(error) });
        }
      }
      return { status: 'completed', trigger, checked: messageIds.length, results };
    },

    async listPublished({ limit = 100 } = {}) {
      const { rows } = await pool.query(
        `SELECT slug, title, excerpt, cover_image_url, published_at
         FROM automated_news_posts
         WHERE status = 'published'
         ORDER BY published_at DESC
         LIMIT $1`,
        [Math.min(Math.max(1, limit), 200)],
      );
      return rows.map((row) => toPost(row));
    },

    async getPublished(slug) {
      if (typeof slug !== 'string' || slug.length > 140 || !SLUG_PATTERN.test(slug)) {
        return null;
      }
      const { rows } = await pool.query(
        `SELECT slug, title, excerpt, cover_image_url, published_at, html_content
         FROM automated_news_posts
         WHERE slug = $1 AND status = 'published'`,
        [slug],
      );
      return rows[0] ? toPost(rows[0], { includeHtml: true }) : null;
    },

    // Operator helpers used by scripts/auto-news.js.
    async listRecent(limit = 20) {
      const { rows } = await pool.query(
        `SELECT gmail_message_id, slug, title, status, attempts, last_error, published_at, created_at,
                jsonb_array_length(images) AS image_count, jsonb_array_length(links) AS link_count
         FROM automated_news_posts
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit],
      );
      return rows;
    },

    async getBySlug(slug) {
      const { rows } = await pool.query(
        'SELECT * FROM automated_news_posts WHERE slug = $1',
        [slug],
      );
      return rows[0] ?? null;
    },

    async setStatus(slug, fromStatuses, toStatus) {
      const { rows } = await pool.query(
        `UPDATE automated_news_posts
         SET status = $3, updated_at = NOW()
         WHERE slug = $1 AND status = ANY($2::text[])
         RETURNING slug, status`,
        [slug, fromStatuses, toStatus],
      );
      return rows[0] ?? null;
    },

    async resetAttempts(slug) {
      const { rows } = await pool.query(
        `UPDATE automated_news_posts
         SET attempts = 0, updated_at = NOW()
         WHERE slug = $1 AND status = 'failed'
         RETURNING slug, status`,
        [slug],
      );
      return rows[0] ?? null;
    },
  };
}
