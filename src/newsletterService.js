import { createHash, randomUUID } from 'node:crypto';
import { createUnsubscribeToken, readUnsubscribeToken, isValidVerificationToken } from './tokens.js';
import { isValidEmail, isValidHtml, normalizeEmail } from './validation.js';

const MAX_SUBJECT_LENGTH = 998;
const MAX_TITLE_LENGTH = 300;

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function toPlainText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlPage(title, message) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="margin:0;background:#f8fafc;font:16px Arial,sans-serif;color:#0f172a"><main style="max-width:560px;margin:12vh auto;padding:32px;background:#fff;border:1px solid #e2e8f0;border-radius:12px"><h1 style="font-size:24px">${escapeHtml(title)}</h1><p style="line-height:1.6;color:#475569">${escapeHtml(message)}</p></main></body></html>`;
}

function appendUnsubscribeLink(html, token, siteUrl) {
  const url = `${siteUrl}/newsletter/unsubscribe?token=${encodeURIComponent(token)}`;
  const footer = `<hr style="border:0;border-top:1px solid #e2e8f0;margin:32px 0 16px"><p style="font:12px Arial,sans-serif;color:#64748b">You are receiving this email because you subscribed to the DerivionAcademy newsletter. <a href="${url}" style="color:#1d4ed8">Unsubscribe</a></p>`;
  return /<\/body\s*>/i.test(html)
    ? html.replace(/<\/body\s*>/i, `${footer}</body>`)
    : `${html}${footer}`;
}

export function createNewsletterService({ pool, emailService, config, logger = console }) {
  async function subscribe(inputEmail) {
    if (typeof inputEmail !== 'string' || !isValidEmail(inputEmail.trim())) {
      const error = new Error('Enter a valid email address.');
      error.statusCode = 400;
      throw error;
    }

    const email = normalizeEmail(inputEmail);
    const unsubscribeToken = randomUUID();
    await pool.query(
      `INSERT INTO subscribers
         (id, email, status, verification_token, unsubscribe_token, verified_at, subscribed_at, unsubscribed_at)
       VALUES ($1, $2, 'active', NULL, $3, NULL, NOW(), NULL)
       ON CONFLICT (email) DO UPDATE SET
         verification_token = CASE WHEN subscribers.status IN ('pending', 'unsubscribed')
           THEN NULL ELSE subscribers.verification_token END,
         unsubscribe_token = CASE WHEN subscribers.status IN ('pending', 'unsubscribed')
           THEN EXCLUDED.unsubscribe_token ELSE subscribers.unsubscribe_token END,
         verified_at = CASE WHEN subscribers.status IN ('pending', 'unsubscribed')
           THEN NULL ELSE subscribers.verified_at END,
         subscribed_at = CASE WHEN subscribers.status IN ('pending', 'unsubscribed')
           THEN NOW() ELSE subscribers.subscribed_at END,
         unsubscribed_at = CASE WHEN subscribers.status IN ('pending', 'unsubscribed')
           THEN NULL ELSE subscribers.unsubscribed_at END,
         status = CASE WHEN subscribers.status IN ('pending', 'unsubscribed')
           THEN 'active' ELSE subscribers.status END`,
      [randomUUID(), email, unsubscribeToken],
    );

    return { message: 'You are subscribed to the weekly newsletter.' };
  }

  async function verify(token) {
    if (!isValidVerificationToken(token)) {
      return { ok: false };
    }

    const result = await pool.query(
      `UPDATE subscribers
       SET status = 'active',
           verified_at = NOW(),
           subscribed_at = NOW(),
           verification_token = NULL,
           unsubscribe_token = $1
       WHERE verification_token = $2 AND status = 'pending'`,
      [randomUUID(), token],
    );
    return { ok: result.rowCount === 1 };
  }

  async function unsubscribe(token) {
    const tokenClaims = readUnsubscribeToken(token, config.tokenSecret);
    if (!tokenClaims) {
      return { ok: false };
    }

    const result = await pool.query(
      `UPDATE subscribers
       SET status = 'unsubscribed',
           unsubscribed_at = COALESCE(unsubscribed_at, NOW()),
           verification_token = NULL
       WHERE id = $1 AND unsubscribe_token = $2 AND status = 'active'`,
      [tokenClaims.subscriberId, tokenClaims.unsubscribeToken],
    );

    if (result.rowCount === 1) {
      return { ok: true };
    }

    const existing = await pool.query(
      `SELECT 1 FROM subscribers
       WHERE id = $1 AND unsubscribe_token = $2 AND status = 'unsubscribed'`,
      [tokenClaims.subscriberId, tokenClaims.unsubscribeToken],
    );
    return { ok: existing.rowCount === 1 };
  }

  async function sendTestEmail({ to, subject, htmlContent }) {
    if (!isValidEmail(to)) {
      const error = new Error('Enter a valid test recipient email address.');
      error.statusCode = 400;
      throw error;
    }
    if (typeof subject !== 'string' || !subject.trim() || subject.length > MAX_SUBJECT_LENGTH) {
      const error = new Error(`Subject must be between 1 and ${MAX_SUBJECT_LENGTH} characters.`);
      error.statusCode = 400;
      throw error;
    }
    if (!isValidHtml(htmlContent)) {
      const error = new Error('Provide newsletter HTML no larger than 450 KB.');
      error.statusCode = 400;
      throw error;
    }

    const previewBanner = '<div style="padding:10px;background:#fff7ed;color:#9a3412;font:13px Arial,sans-serif">TEST PREVIEW — this message was sent only to the requested test address.</div>';
    const html = /<body\b[^>]*>/i.test(htmlContent)
      ? htmlContent.replace(/<body\b[^>]*>/i, (bodyTag) => `${bodyTag}${previewBanner}`)
      : `${previewBanner}${htmlContent}`;
    await emailService.sendEmail({
      to: normalizeEmail(to),
      subject: `[TEST] ${subject.trim()}`,
      html,
      text: `TEST PREVIEW\n\n${toPlainText(htmlContent)}`,
    });
    return { message: 'Test newsletter email sent.' };
  }

  async function claimNextDueNewsletter() {
    const client = await pool.connect();
    let claimed = false;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, title, subject, html_content, send_at
         FROM newsletters
         WHERE (status = 'scheduled' AND send_at <= NOW())
            OR (status = 'sending'
                AND updated_at < NOW() - ($1 * INTERVAL '1 minute'))
         ORDER BY send_at, id
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [config.staleSendMinutes],
      );
      const newsletter = rows[0];
      if (!newsletter) {
        await client.query('COMMIT');
        return null;
      }

      const lock = await client.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
        [newsletter.id],
      );
      if (!lock.rows[0]?.acquired) {
        await client.query('COMMIT');
        return null;
      }

      await client.query(
        `UPDATE newsletters
         SET status = 'sending', updated_at = NOW()
         WHERE id = $1`,
        [newsletter.id],
      );
      await client.query('COMMIT');
      claimed = true;
      return { newsletter, client };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Newsletter claim transaction failed.');
      }
      throw error;
    } finally {
      if (!claimed) {
        client.release();
      }
    }
  }

  async function releaseNewsletterClaim(claim) {
    try {
      const result = await claim.client.query(
        'SELECT pg_advisory_unlock(hashtext($1)) AS released',
        [claim.newsletter.id],
      );
      if (!result.rows[0]?.released) {
        throw new Error(`Could not release newsletter lock for ${claim.newsletter.id}.`);
      }
    } finally {
      claim.client.release();
    }
  }

  async function sendNewsletterNow({ title, subject, htmlContent, resend = false }) {
    if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE_LENGTH) {
      throw new Error(`Title must be between 1 and ${MAX_TITLE_LENGTH} characters.`);
    }
    if (typeof subject !== 'string' || !subject.trim() || subject.length > MAX_SUBJECT_LENGTH) {
      throw new Error(`Subject must be between 1 and ${MAX_SUBJECT_LENGTH} characters.`);
    }
    if (!isValidHtml(htmlContent)) {
      throw new Error('Provide newsletter HTML no larger than 450 KB.');
    }

    const client = await pool.connect();
    let newsletter;
    const lockName = `newsletter:${createHash('sha256')
      .update(`${title}\0${subject}\0${htmlContent}`)
      .digest('hex')
      .slice(0, 40)}`;
    let transactionStarted = false;
    let sendError;

    try {
      await client.query('BEGIN');
      transactionStarted = true;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockName]);
      let campaigns = [];
      if (!resend) {
        const existing = await client.query(
          `SELECT id, title, subject, html_content, status
           FROM newsletters
           WHERE title = $1 AND subject = $2 AND html_content = $3
           ORDER BY created_at DESC
           LIMIT 1
           FOR UPDATE`,
          [title, subject, htmlContent],
        );
        campaigns = existing.rows;
      }

      if (campaigns[0]) {
        const campaign = campaigns[0];
        if (campaign.status === 'sending') {
          throw new Error(`This newsletter campaign is already ${campaign.status}.`);
        }
        if (!['draft', 'scheduled', 'failed', 'sent'].includes(campaign.status)) {
          throw new Error(`Cannot send a newsletter campaign with status "${campaign.status}".`);
        }
        const updated = await client.query(
          `UPDATE newsletters
           SET status = 'sending', send_at = NOW(), sent_at = NULL,
               updated_at = NOW()
           WHERE id = $1 AND status = $2`,
          [campaign.id, campaign.status],
        );
        if (updated.rowCount !== 1) {
          throw new Error('The newsletter campaign changed before it could be sent.');
        }
        newsletter = campaign;
      } else {
        newsletter = {
          id: randomUUID(),
          title,
          subject,
          html_content: htmlContent,
        };
        const inserted = await client.query(
          `INSERT INTO newsletters (id, title, subject, html_content, send_at, status)
           VALUES ($1, $2, $3, $4, NOW(), 'sending')
           RETURNING id, title, subject, html_content`,
          [newsletter.id, title, subject, htmlContent],
        );
        newsletter = inserted.rows[0];
      }

      await client.query('COMMIT');
      transactionStarted = false;
    } catch (error) {
      sendError = error;
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          sendError = new AggregateError(
            [error, rollbackError],
            'Newsletter campaign transaction failed.',
          );
        }
      }
    } finally {
      client.release();
    }

    if (sendError) {
      throw sendError;
    }

    try {
      return { newsletterId: newsletter.id, ...(await sendNewsletter(newsletter)) };
    } catch (error) {
      await pool.query(
        `UPDATE newsletters
         SET status = 'failed', sent_at = NULL, updated_at = NOW()
         WHERE id = $1 AND status = 'sending'`,
        [newsletter.id],
      );
      throw error;
    }
  }

  async function sendOneRecipient(newsletter, subscriber) {
    const delivery = await pool.query(
      `INSERT INTO newsletter_deliveries
         (newsletter_id, subscriber_id, status, attempts, last_error, updated_at)
       VALUES ($1, $2, 'sending', 1, NULL, NOW())
       ON CONFLICT (newsletter_id, subscriber_id) DO UPDATE SET
         attempts = CASE WHEN newsletter_deliveries.status = 'sent'
           THEN newsletter_deliveries.attempts ELSE newsletter_deliveries.attempts + 1 END,
         last_error = CASE WHEN newsletter_deliveries.status = 'sent'
           THEN newsletter_deliveries.last_error ELSE NULL END,
         status = CASE WHEN newsletter_deliveries.status = 'sent'
           THEN newsletter_deliveries.status ELSE 'sending' END,
         updated_at = CASE WHEN newsletter_deliveries.status = 'sent'
           THEN newsletter_deliveries.updated_at ELSE NOW() END
       RETURNING status`,
      [newsletter.id, subscriber.id],
    );
    if (delivery.rows[0]?.status === 'sent') {
      return { failed: false, skipped: true };
    }

    try {
      const html = appendUnsubscribeLink(
        newsletter.html_content,
        createUnsubscribeToken(subscriber.id, subscriber.unsubscribe_token, config.tokenSecret),
        config.apiPublicUrl,
      );
      await emailService.sendEmail({
        to: subscriber.email,
        subject: newsletter.subject,
        html,
        text: `${toPlainText(newsletter.html_content)}\n\nUnsubscribe: ${config.apiPublicUrl}/api/newsletter/unsubscribe/${createUnsubscribeToken(subscriber.id, subscriber.unsubscribe_token, config.tokenSecret)}`,
      });
      await pool.query(
        `UPDATE newsletter_deliveries
         SET status = 'sent', sent_at = NOW(), last_error = NULL,
             updated_at = NOW()
         WHERE newsletter_id = $1 AND subscriber_id = $2`,
        [newsletter.id, subscriber.id],
      );
      return { failed: false, skipped: false };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await pool.query(
        `UPDATE newsletter_deliveries
         SET status = 'failed', last_error = $1, updated_at = NOW()
         WHERE newsletter_id = $2 AND subscriber_id = $3`,
        [errorMessage.slice(0, 1000), newsletter.id, subscriber.id],
      );
      logger.error('Newsletter recipient delivery failed', {
        newsletterId: newsletter.id,
        subscriberId: subscriber.id,
        error: errorMessage,
      });
      return { failed: true, skipped: false };
    }
  }

  async function sendNewsletter(newsletter) {
    if (typeof newsletter.title !== 'string' || newsletter.title.length > MAX_TITLE_LENGTH
      || typeof newsletter.subject !== 'string' || newsletter.subject.length > MAX_SUBJECT_LENGTH
      || !isValidHtml(newsletter.html_content)) {
      throw new Error(`Newsletter ${newsletter.id} has invalid title, subject, or HTML content.`);
    }

    let lastSubscriberId = '00000000-0000-0000-0000-000000000000';
    let failedCount = 0;
    let sentCount = 0;

    while (true) {
      const subscribersResult = await pool.query(
        `SELECT subscriber.id, subscriber.email, subscriber.unsubscribe_token
         FROM subscribers AS subscriber
         WHERE subscriber.status = 'active'
           AND subscriber.id > $1
           AND NOT EXISTS (
             SELECT 1
             FROM newsletter_deliveries AS delivery
             WHERE delivery.newsletter_id = $2
               AND delivery.subscriber_id = subscriber.id
               AND delivery.status = 'sent'
           )
         ORDER BY subscriber.id
         LIMIT $3`,
        [lastSubscriberId, newsletter.id, config.batchSize],
      );
      const subscribers = subscribersResult.rows;

      if (subscribers.length === 0) {
        break;
      }

      lastSubscriberId = subscribers[subscribers.length - 1].id;
      for (let index = 0; index < subscribers.length; index += config.sendConcurrency) {
        const batch = subscribers.slice(index, index + config.sendConcurrency);
        const results = await Promise.all(batch.map((subscriber) => sendOneRecipient(newsletter, subscriber)));
        failedCount += results.filter((result) => result.failed).length;
        sentCount += results.filter((result) => !result.failed && !result.skipped).length;
      }
      await pool.query(
        `UPDATE newsletters SET updated_at = NOW()
         WHERE id = $1 AND status = 'sending'`,
        [newsletter.id],
      );
    }

    const status = failedCount > 0 ? 'failed' : 'sent';
    await pool.query(
      `UPDATE newsletters
       SET status = $1, sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE NULL END,
           updated_at = NOW()
       WHERE id = $3`,
      [status, status, newsletter.id],
    );

    logger.info('Newsletter send finished', {
      newsletterId: newsletter.id,
      status,
      sentCount,
      failedCount,
    });
    return { status, sentCount, failedCount };
  }

  async function processDueNewsletters() {
    let claimedCount = 0;
    while (true) {
      const claim = await claimNextDueNewsletter();
      if (!claim) {
        break;
      }

      claimedCount += 1;
      try {
        try {
          await sendNewsletter(claim.newsletter);
        } catch (error) {
          logger.error('Newsletter campaign failed', {
            newsletterId: claim.newsletter.id,
            error: error instanceof Error ? error.message : String(error),
          });
          await pool.query(
            `UPDATE newsletters
             SET status = 'failed', sent_at = NULL, updated_at = NOW()
             WHERE id = $1`,
            [claim.newsletter.id],
          );
        }
      } finally {
        await releaseNewsletterClaim(claim);
      }
    }
    return claimedCount;
  }

  return {
    subscribe,
    verify,
    unsubscribe,
    sendTestEmail,
    sendNewsletterNow,
    processDueNewsletters,
  };
}

export { appendUnsubscribeLink, htmlPage, toPlainText };
