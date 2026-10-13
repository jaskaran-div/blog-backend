import 'dotenv/config';
import cron from 'node-cron';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createEmailService } from './emailService.js';
import { createGracefulShutdown } from './gracefulShutdown.js';
import { createNewsletterService } from './newsletterService.js';

const config = loadConfig();
const pool = createDatabase(config);
const emailService = createEmailService(config);
const newsletterService = createNewsletterService({ pool, emailService, config });
const app = createApp({
  newsletterService,
  emailService,
  config,
  healthCheck: async () => pool.query('SELECT 1'),
});
if (!cron.validate(config.cronSchedule)) {
  throw new Error('NEWSLETTER_CRON_SCHEDULE is not a valid cron expression.');
}
try {
  await pool.query('SELECT 1');
} catch (error) {
  console.error('Database connectivity check failed.', { code: error?.code ?? 'UNKNOWN' });
  await pool.end();
  throw new Error('Database connectivity check failed.');
}
const keepAliveIntervalMs = 30 * 1000;
const keepAliveUrl = (process.env.RENDER_EXTERNAL_URL || (
  config.nodeEnv === 'production' ? config.apiPublicUrl : ''
)).replace(/\/+$/, '');
let keepAliveInterval;
async function pingSelf() {
  try {
    const response = await fetch(`${keepAliveUrl}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.warn('Self-ping returned an unsuccessful status.', { status: response.status });
    }
  } catch (error) {
    console.warn('Self-ping request failed.', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

const server = app.listen(config.port, () => {
  console.info(`Newsletter Express API listening on port ${config.port}`);
  if (keepAliveUrl) {
    void pingSelf();
  }
});

let newsletterProcessing;
async function processDueNewsletters() {
  if (newsletterProcessing) {
    return newsletterProcessing;
  }
  newsletterProcessing = (async () => {
    try {
      const count = await newsletterService.processDueNewsletters();
      if (count > 0) {
        console.info('Scheduled newsletter jobs claimed', { count });
      }
    } catch (error) {
      console.error('Scheduled newsletter check failed', { code: error?.code ?? 'UNKNOWN' });
    } finally {
      newsletterProcessing = null;
    }
  })();
  return newsletterProcessing;
}

const scheduledJob = cron.schedule(config.cronSchedule, processDueNewsletters);
void processDueNewsletters();

if (keepAliveUrl) {
  console.info('Self-ping enabled.', { intervalSeconds: keepAliveIntervalMs / 1000 });
  keepAliveInterval = setInterval(() => void pingSelf(), keepAliveIntervalMs);
  keepAliveInterval.unref();
}

const shutdown = createGracefulShutdown({
  server,
  scheduledJob,
  keepAliveInterval,
  pool,
  waitForNewsletterProcessing: async () => {
    if (newsletterProcessing) {
      await newsletterProcessing;
    }
  },
});

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
