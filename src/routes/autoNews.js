import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';

function matchesSecret(provided, expected) {
  if (typeof provided !== 'string' || !expected) {
    return false;
  }
  const first = Buffer.from(provided);
  const second = Buffer.from(expected);
  return first.length === second.length && timingSafeEqual(first, second);
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

export function createAutoNewsRouter({ autoNewsService, config, runImport, logger = console }) {
  const router = Router();
  const importLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'Too many import requests. Please try again later.' },
  });

  // Public, read-only: only published posts are ever returned.
  router.get('/posts', asyncRoute(async (_request, response) => {
    try {
      const posts = await autoNewsService.listPublished();
      response.set('Cache-Control', 'public, max-age=60');
      response.json({ posts });
    } catch (error) {
      logger.error('Automated news list failed.', { code: error?.code ?? 'UNKNOWN' });
      response.set('Cache-Control', 'no-store');
      response.status(503).json({ message: 'Automated news is temporarily unavailable.', posts: [] });
    }
  }));

  router.get('/posts/:slug', asyncRoute(async (request, response) => {
    let post;
    try {
      post = await autoNewsService.getPublished(request.params.slug);
    } catch (error) {
      logger.error('Automated news read failed.', { code: error?.code ?? 'UNKNOWN' });
      response.set('Cache-Control', 'no-store');
      response.status(503).json({ message: 'Automated news is temporarily unavailable.' });
      return;
    }
    if (!post) {
      response.set('Cache-Control', 'no-store');
      response.status(404).json({ message: 'News post not found.' });
      return;
    }
    response.set('Cache-Control', 'public, max-age=60');
    response.json({ post });
  }));

  // Manual or external-cron trigger. Requires Authorization: Bearer <AUTO_NEWS_IMPORT_TOKEN>.
  router.post('/import', importLimiter, asyncRoute(async (request, response) => {
    if (!config.autoNews.enabled || !config.autoNews.importToken) {
      response.status(503).json({ message: 'Automated news import is disabled.' });
      return;
    }
    const [scheme, token] = (request.get('authorization') ?? '').split(' ');
    if (scheme !== 'Bearer' || !matchesSecret(token, config.autoNews.importToken)) {
      response.status(401).json({ message: 'Unauthorized.' });
      return;
    }
    response.set('Cache-Control', 'no-store');
    try {
      const body = request.body ?? {};
      response.json(await runImport({
        trigger: 'manual',
        force: body.force === true,
        // Dry run: preview only, nothing is inserted or published.
        dryRun: body.dryRun === true,
        uploadImages: body.uploadImages === true,
        ...(typeof body.messageId === 'string' ? { messageId: body.messageId } : {}),
      }));
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
      if (error?.statusCode === 400) {
        response.status(400).json({ message: error.message, code });
        return;
      }
      logger.error('Automated news import request failed.', { code });
      response.status(502).json({ message: 'Automated news import failed.', code });
    }
  }));

  return router;
}
