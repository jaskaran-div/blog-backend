import 'dotenv/config';
import cron from 'node-cron';
import { createApp } from './app.js';
import { createAutoNewsService } from './autoNewsService.js';
import { createCloudinaryUploader } from './cloudinaryUploader.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createEmailService } from './emailService.js';
import { createGmailClient } from './gmailClient.js';
import { createGracefulShutdown } from './gracefulShutdown.js';
import { createMarketSnapshotService } from './marketSnapshotService.js';
import { createNewsletterService } from './newsletterService.js';

const config = loadConfig();
const pool = createDatabase(config);
const emailService = createEmailService(config);
const newsletterService = createNewsletterService({ pool, emailService, config });
const marketSnapshotService = createMarketSnapshotService({ pool, config });
// Read endpoints always work; Gmail and Cloudinary are only contacted when AUTO_NEWS_ENABLED is true.
const autoNewsService = createAutoNewsService({
  pool,
  config: config.autoNews,
  gmail: config.autoNews.enabled ? createGmailClient(config.autoNews.gmail) : null,
  uploadImage: config.autoNews.enabled ? createCloudinaryUploader(config.autoNews.cloudinary) : null,
});

let autoNewsImport;
function runAutoNewsImport(options) {
  // Dry runs never write, so they need not wait for (or share) an in-flight import.
  if (options?.dryRun) {
    return autoNewsService.runImport(options);
  }
  if (!autoNewsImport) {
    autoNewsImport = autoNewsService.runImport(options).finally(() => {
      autoNewsImport = null;
    });
  }
  return autoNewsImport;
}

const app = createApp({
  newsletterService,
  emailService,
  marketSnapshotService,
  autoNewsService,
  runAutoNewsImport,
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

let marketSnapshotRefresh;
async function refreshMarketSnapshot(trigger) {
  if (marketSnapshotRefresh) {
    return marketSnapshotRefresh;
  }
  marketSnapshotRefresh = (async () => {
    try {
      await marketSnapshotService.refresh({ trigger });
    } catch (error) {
      console.error('Market snapshot refresh could not complete.', { trigger, code: error?.code ?? 'UNKNOWN' });
    } finally {
      marketSnapshotRefresh = null;
    }
  })();
  return marketSnapshotRefresh;
}

const { timezone: marketTimezone, cronExpressions: marketCronExpressions } = config.marketSnapshot;
const marketSnapshotJobs = marketCronExpressions.map((expression, index) => cron.schedule(
  expression,
  () => refreshMarketSnapshot('scheduled'),
  { timezone: marketTimezone, name: `market-snapshot-${index + 1}`, noOverlap: true },
));
if (marketSnapshotJobs.length > 0) {
  console.info('Market snapshot schedule enabled.', {
    timezone: marketTimezone,
    times: config.marketSnapshot.times,
    days: config.marketSnapshot.days,
  });
} else {
  console.info('Market snapshot schedule disabled; set MARKET_SNAPSHOT_TIMES to enable it.');
}
if (config.marketSnapshot.bootstrapIfEmpty) {
  // Only fills an empty table, so restarts never change values between scheduled updates.
  void (async () => {
    try {
      if (!(await marketSnapshotService.hasSuccessfulSnapshot())) {
        await refreshMarketSnapshot('bootstrap');
      }
    } catch (error) {
      console.warn('Market snapshot bootstrap check failed; run npm run db:migrate if the table is missing.', {
        code: error?.code ?? 'UNKNOWN',
      });
    }
  })();
}

const autoNewsJobs = [];
if (config.autoNews.enabled) {
  autoNewsJobs.push(cron.schedule(config.autoNews.cronExpression, async () => {
    try {
      const result = await runAutoNewsImport({ trigger: 'scheduled' });
      if (result.results?.length > 0) {
        console.info('Automated news check finished.', {
          checked: result.checked,
          results: result.results.map(({ slug, status }) => ({ slug, status })),
        });
      }
    } catch (error) {
      console.error('Automated news check failed.', { code: error?.code ?? 'UNKNOWN' });
    }
  }, { timezone: config.autoNews.timezone, name: 'auto-news-gmail-check', noOverlap: true }));
  console.info('Automated news Gmail checks enabled.', {
    timezone: config.autoNews.timezone,
    schedule: config.autoNews.cronExpression,
    autoPublish: config.autoNews.autoPublish,
  });
} else {
  console.info('Automated news Gmail checks disabled; set AUTO_NEWS_ENABLED=true to enable them.');
}

if (keepAliveUrl) {
  console.info('Self-ping enabled.', { intervalSeconds: keepAliveIntervalMs / 1000 });
  keepAliveInterval = setInterval(() => void pingSelf(), keepAliveIntervalMs);
  keepAliveInterval.unref();
}

const shutdown = createGracefulShutdown({
  server,
  scheduledJob,
  additionalScheduledJobs: [...marketSnapshotJobs, ...autoNewsJobs],
  keepAliveInterval,
  pool,
  waitForNewsletterProcessing: async () => {
    if (newsletterProcessing) {
      await newsletterProcessing;
    }
  },
  waitForBackgroundTasks: async () => {
    if (marketSnapshotRefresh) {
      await marketSnapshotRefresh;
    }
    if (autoNewsImport) {
      await autoNewsImport.catch(() => {});
    }
  },
});

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
