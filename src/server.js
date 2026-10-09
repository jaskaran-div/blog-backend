import 'dotenv/config';
import cron from 'node-cron';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createEmailService } from './emailService.js';
import { createNewsletterService } from './newsletterService.js';

const config = loadConfig();
const pool = createDatabase(config);
const emailService = createEmailService(config);
const newsletterService = createNewsletterService({ pool, emailService, config });
const app = createApp({ newsletterService, emailService, config });
if (!cron.validate(config.cronSchedule)) {
  throw new Error('NEWSLETTER_CRON_SCHEDULE is not a valid cron expression.');
}
await pool.query('select 1');
const server = app.listen(config.port, () => {
  console.info(`Newsletter Express API listening on port ${config.port}`);
});

let processingDueNewsletters = false;
async function processDueNewsletters() {
  if (processingDueNewsletters) {
    return;
  }
  processingDueNewsletters = true;
  try {
    const count = await newsletterService.processDueNewsletters();
    if (count > 0) {
      console.info('Scheduled newsletter jobs claimed', { count });
    }
  } catch (error) {
    console.error('Scheduled newsletter check failed', error);
  } finally {
    processingDueNewsletters = false;
  }
}

const scheduledJob = cron.schedule(config.cronSchedule, processDueNewsletters);
void processDueNewsletters();

async function shutdown(signal) {
  console.info(`Received ${signal}; closing newsletter service.`);
  scheduledJob.stop();
  server.close(async (error) => {
    if (error) {
      console.error('Could not close the HTTP server cleanly', error);
      process.exitCode = 1;
    }
    await pool.end();
  });
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
