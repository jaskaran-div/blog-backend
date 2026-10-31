import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createDatabase } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { createEmailService } from '../src/emailService.js';
import { createNewsletterService } from '../src/newsletterService.js';

const config = loadConfig();
const pool = createDatabase(config);
const args = process.argv.slice(2);
const resend = args.includes('--resend');

try {
  if (args.some((argument) => argument !== '--resend')) {
    throw new Error('Usage: npm run newsletter:send [-- --resend]');
  }

  const htmlContent = await readFile(
    new URL('../../frontend/public/Newsletter/isft-weekly-newsletter-week-44.html', import.meta.url),
    'utf8',
  );
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE subscriber.status = 'active')::INTEGER AS active_count,
       COUNT(*) FILTER (
         WHERE subscriber.status = 'active'
           AND NOT EXISTS (
             SELECT 1
             FROM newsletter_deliveries AS delivery
             JOIN newsletters AS newsletter ON newsletter.id = delivery.newsletter_id
             WHERE newsletter.html_content = $1
               AND delivery.subscriber_id = subscriber.id
               AND delivery.status = 'sent'
           )
       )::INTEGER AS eligible_count
     FROM subscribers AS subscriber`,
    [htmlContent],
  );
  const activeCount = Number(rows[0].active_count);
  const eligibleCount = Number(rows[0].eligible_count);
  if (activeCount === 0) {
    throw new Error('There are no active newsletter subscribers to send to.');
  }
  if (!resend && eligibleCount === 0) {
    console.info('No unsent active subscribers for this newsletter. Existing recipients will not receive a duplicate.');
    process.exitCode = 0;
  } else {
    if (resend) {
      console.info(`Resending as a new campaign to all ${activeCount} active subscriber(s).`);
    }
    const newsletterService = createNewsletterService({
      pool,
      emailService: createEmailService(config),
      config,
    });
    const result = await newsletterService.sendNewsletterNow({
      title: 'ISFT Weekly Newsletter — 30 Oct 2026',
      subject: 'ISFT Weekly Newsletter | 30 Oct 2026',
      htmlContent,
      resend,
    });

    console.info('Newsletter send finished', result);
    if (result.status !== 'sent') {
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error('Newsletter send failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
