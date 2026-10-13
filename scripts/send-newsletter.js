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
    new URL('../../frontend/public/Newsletter/isft-weekly-newsletter.html', import.meta.url),
    'utf8',
  );
  const { rows } = await pool.query(
    `select
       count(*) filter (where subscriber.status = 'active')::int as active_count,
       count(*) filter (
         where subscriber.status = 'active'
           and not exists (
             select 1
             from public.newsletter_deliveries as delivery
             join public.newsletters as newsletter on newsletter.id = delivery.newsletter_id
             where newsletter.html_content = $1
               and delivery.subscriber_id = subscriber.id
               and delivery.status = 'sent'
           )
       )::int as eligible_count
     from public.subscribers as subscriber`,
    [htmlContent],
  );
  if (rows[0].active_count === 0) {
    throw new Error('There are no active newsletter subscribers to send to.');
  }
  if (!resend && rows[0].eligible_count === 0) {
    console.info('No unsent active subscribers for this newsletter. Existing recipients will not receive a duplicate.');
    process.exitCode = 0;
  } else {
    if (resend) {
      console.info(`Resending as a new campaign to all ${rows[0].active_count} active subscriber(s).`);
    }
    const newsletterService = createNewsletterService({
      pool,
      emailService: createEmailService(config),
      config,
    });
    const result = await newsletterService.sendNewsletterNow({
      title: 'ISFT Weekly Newsletter — 09 Oct 2026',
      subject: 'ISFT Weekly Newsletter | 09 Oct 2026',
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
