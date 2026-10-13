import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createEmailService } from '../src/emailService.js';
import { loadEmailConfig } from '../src/config.js';
import { createNewsletterService } from '../src/newsletterService.js';

const [recipient, ...extraArgs] = process.argv.slice(2);
if (!recipient || extraArgs.length > 0) {
  console.error('Usage: npm run newsletter:preview -- <recipient-email>');
  process.exitCode = 1;
} else {
  try {
    const htmlContent = await readFile(
      new URL('../../frontend/public/Newsletter/isft-weekly-newsletter.html', import.meta.url),
      'utf8',
    );
    const emailConfig = loadEmailConfig();
    const newsletterService = createNewsletterService({
      emailService: createEmailService(emailConfig),
      config: emailConfig,
    });
    const result = await newsletterService.sendTestEmail({
      to: recipient,
      subject: 'ISFT Weekly Newsletter preview',
      htmlContent,
    });
    console.info(result.message, { recipient });
  } catch (error) {
    console.error('Newsletter preview failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
