import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isValidEmail, isValidHtml } from '../validation.js';
import { htmlPage } from '../newsletterService.js';

function matchesSecret(provided, expected) {
  if (typeof provided !== 'string') {
    return false;
  }
  const first = Buffer.from(provided);
  const second = Buffer.from(expected);
  return first.length === second.length && timingSafeEqual(first, second);
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

export function createNewsletterRouter({ newsletterService, emailService, config, logger = console }) {
  const router = Router();
  const subscribeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'Too many subscription attempts. Please try again later.' },
  });

  router.post('/subscribe', subscribeLimiter, asyncRoute(async (request, response) => {
    const result = await newsletterService.subscribe(request.body?.email);
    response.status(200).json(result);
  }));

  router.get('/verify/:token', asyncRoute(async (request, response) => {
    const result = await newsletterService.verify(request.params.token);
    response
      .status(result.ok ? 200 : 400)
      .type('html')
      .send(result.ok
        ? htmlPage('Email verified', 'Your subscription is confirmed. You will receive the weekly DerivionAcademy newsletter.')
        : htmlPage('Verification link invalid', 'This verification link is invalid or has already been used.'));
  }));

  router.get('/unsubscribe/:token', asyncRoute(async (request, response) => {
    const result = await newsletterService.unsubscribe(request.params.token);
    response
      .status(result.ok ? 200 : 400)
      .type('html')
      .send(result.ok
        ? htmlPage('Unsubscribed', 'You will no longer receive the DerivionAcademy newsletter.')
        : htmlPage('Unsubscribe link invalid', 'This unsubscribe link is invalid.'));
  }));

  router.use('/test', (request, response, next) => {
    const provided = request.get('x-newsletter-admin-token');
    if (!matchesSecret(provided, config.adminToken)) {
      response.status(401).json({ message: 'Unauthorized.' });
      return;
    }
    next();
  });

  router.get('/test/ses', asyncRoute(async (_request, response) => {
    try {
      const quota = await emailService.verifyConnection();
      response.json({ message: 'SES connection succeeded.', quota });
    } catch (error) {
      logger.error('SES connection test failed', error);
      response.status(502).json({ message: 'SES connection failed.' });
    }
  }));

  router.post('/test/email', asyncRoute(async (request, response) => {
    const { to, subject, html_content: htmlContent } = request.body ?? {};
    if (!isValidEmail(to) || typeof subject !== 'string' || !subject.trim() || !isValidHtml(htmlContent)) {
      response.status(400).json({ message: 'Provide a valid to address, subject, and HTML newsletter content.' });
      return;
    }

    const result = await newsletterService.sendTestEmail({ to, subject, htmlContent });
    response.json(result);
  }));

  return router;
}
