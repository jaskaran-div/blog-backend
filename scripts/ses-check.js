import 'dotenv/config';
import { loadEmailConfig } from '../src/config.js';
import { createEmailService } from '../src/emailService.js';

try {
  const emailService = createEmailService(loadEmailConfig());
  const quota = await emailService.verifyConnection();
  console.info('SES connection succeeded.', {
    max24HourSend: quota.Max24HourSend,
    sentLast24Hours: quota.SentLast24Hours,
    maxSendRate: quota.MaxSendRate,
  });
} catch (error) {
  console.error('SES connection test failed.', error);
  process.exitCode = 1;
}
