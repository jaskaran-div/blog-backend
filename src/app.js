import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { createNewsletterRouter } from './routes/newsletter.js';

export function createApp({
  newsletterService,
  emailService,
  config,
  healthCheck = async () => {},
  logger = console,
}) {
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxyHops > 0) {
    app.set('trust proxy', config.trustProxyHops);
  }
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      callback(null, !origin || config.allowedOrigins.includes(origin));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Newsletter-Admin-Token'],
    maxAge: 600,
  }));
  app.use(express.json({ limit: '500kb', strict: true }));

  app.get('/health', async (_request, response) => {
    try {
      await healthCheck();
      response.json({ status: 'ok' });
    } catch {
      logger.error('Application health check failed.');
      response.status(503).json({ status: 'error' });
    }
  });
  app.use('/api/newsletter', createNewsletterRouter({
    newsletterService,
    emailService,
    config,
    logger,
  }));

  app.use((request, response) => {
    response.status(404).json({ message: 'Route not found.' });
  });

  app.use((error, _request, response, _next) => {
    logger.error('Newsletter API request failed', error);
    if (response.headersSent) {
      return;
    }
    const statusCode = Number.isInteger(error.statusCode)
      ? error.statusCode
      : Number.isInteger(error.status) ? error.status : 500;
    const message = error.type === 'entity.parse.failed'
      ? 'Request body must be valid JSON.'
      : statusCode === 413 ? 'Request body is too large.'
        : statusCode < 500 ? error.message : 'The newsletter request could not be completed.';
    response.status(statusCode).json({
      message,
    });
  });

  return app;
}
