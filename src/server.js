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
const server = app.listen(config.port, () => {
  console.info(`Newsletter Express API listening on port ${config.port}`);
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

const shutdown = createGracefulShutdown({
  server,
  scheduledJob,
  pool,
  waitForNewsletterProcessing: async () => {
    if (newsletterProcessing) {
      await newsletterProcessing;
    }
  },
});

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
