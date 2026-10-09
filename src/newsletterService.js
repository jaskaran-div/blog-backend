import { randomUUID } from 'node:crypto';
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
  const url = `${siteUrl}/api/newsletter/unsubscribe/${encodeURIComponent(token)}`;
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
    await pool.execute(
      `INSERT INTO subscribers
         (id, email, status, verification_token, unsubscribe_token, verified_at, subscribed_at, unsubscribed_at)
       VALUES (?, ?, 'active', NULL, ?, NULL, CURRENT_TIMESTAMP(3), NULL)
       ON DUPLICATE KEY UPDATE
         verification_token = IF(status IN ('pending', 'unsubscribed'), NULL, verification_token),
         unsubscribe_token = IF(status IN ('pending', 'unsubscribed'), ?, unsubscribe_token),
         verified_at = IF(status IN ('pending', 'unsubscribed'), NULL, verified_at),
         subscribed_at = IF(status IN ('pending', 'unsubscribed'), CURRENT_TIMESTAMP(3), subscribed_at),
         unsubscribed_at = IF(status IN ('pending', 'unsubscribed'), NULL, unsubscribed_at),
         status = IF(status IN ('pending', 'unsubscribed'), 'active', status)`,
      [randomUUID(), email, unsubscribeToken, unsubscribeToken],
    );

    return { message: 'You are subscribed to the weekly newsletter.' };
  }

  async function verify(token) {
    if (!isValidVerificationToken(token)) {
      return { ok: false };
    }

    const [result] = await pool.execute(
      `UPDATE subscribers
       SET status = 'active',
           verified_at = CURRENT_TIMESTAMP(3),
           subscribed_at = CURRENT_TIMESTAMP(3),
           verification_token = NULL,
           unsubscribe_token = ?
       WHERE verification_token = ? AND status = 'pending'`,
      [randomUUID(), token],
    );
    return { ok: result.affectedRows === 1 };
  }

  async function unsubscribe(token) {
    const tokenClaims = readUnsubscribeToken(token, config.tokenSecret);
    if (!tokenClaims) {
      return { ok: false };
    }

    const [result] = await pool.execute(
      `UPDATE subscribers
       SET status = 'unsubscribed',
           unsubscribed_at = COALESCE(unsubscribed_at, CURRENT_TIMESTAMP(3)),
           verification_token = NULL
       WHERE id = ? AND unsubscribe_token = ? AND status = 'active'`,
      [tokenClaims.subscriberId, tokenClaims.unsubscribeToken],
    );

    if (result.affectedRows === 1) {
      return { ok: true };
    }

    const [existing] = await pool.execute(
      `SELECT 1 FROM subscribers
       WHERE id = ? AND unsubscribe_token = ? AND status = 'unsubscribed'`,
      [tokenClaims.subscriberId, tokenClaims.unsubscribeToken],
    );
    return { ok: existing.length === 1 };
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
    const connection = await pool.getConnection();
    let claimed = false;
    let connectionDestroyed = false;
    let lockName;
    try {
      await connection.beginTransaction();
      const skippedIds = [];
      while (true) {
        const exclusion = skippedIds.length
          ? `AND id NOT IN (${skippedIds.map(() => '?').join(', ')})`
          : '';
        const [rows] = await connection.execute(
          `SELECT id, title, subject, html_content, send_at
           FROM newsletters
           WHERE ((status = 'scheduled' AND send_at <= CURRENT_TIMESTAMP(3))
              OR (status = 'sending' AND send_at <= CURRENT_TIMESTAMP(3)
                  AND updated_at < TIMESTAMPADD(MINUTE, ?, CURRENT_TIMESTAMP(3))))
             ${exclusion}
           ORDER BY send_at, id
           LIMIT 1
           FOR UPDATE SKIP LOCKED`,
          [-config.staleSendMinutes, ...skippedIds],
        );
        const newsletter = rows[0];
        if (!newsletter) {
          await connection.commit();
          return null;
        }

        lockName = `newsletter:${newsletter.id}`;
        const [lockRows] = await connection.execute(
          'SELECT GET_LOCK(?, 0) AS acquired',
          [lockName],
        );
        if (lockRows[0]?.acquired !== 1) {
          lockName = undefined;
          skippedIds.push(newsletter.id);
          continue;
        }

        await connection.execute(
          `UPDATE newsletters
           SET status = 'sending', updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ?`,
          [newsletter.id],
        );
        await connection.commit();
        claimed = true;
        return { newsletter, connection, lockName };
      }
    } catch (error) {
      let claimError = error;
      try {
        await connection.rollback();
      } catch (rollbackError) {
        claimError = new AggregateError([error, rollbackError], 'Newsletter claim transaction failed.');
      }
      if (lockName) {
        try {
          const [releaseRows] = await connection.execute(
            'SELECT RELEASE_LOCK(?) AS released',
            [lockName],
          );
          if (releaseRows[0]?.released !== 1) {
            throw new Error('MySQL newsletter claim lock was not released.');
          }
        } catch (releaseError) {
          connection.destroy();
          connectionDestroyed = true;
          claimError = new AggregateError([claimError, releaseError], 'Newsletter claim cleanup failed.');
        }
      }
      throw claimError;
    } finally {
      if (!claimed && !connectionDestroyed) {
        connection.release();
      }
    }
  }

  async function releaseNewsletterClaim(claim) {
    try {
      const [rows] = await claim.connection.execute(
        'SELECT RELEASE_LOCK(?) AS released',
        [claim.lockName],
      );
      if (rows[0]?.released !== 1) {
        throw new Error('MySQL newsletter claim lock was not released.');
      }
    } catch (error) {
      claim.connection.destroy();
      throw error;
    }
    claim.connection.release();
  }

  async function sendOneRecipient(newsletter, subscriber) {
    await pool.execute(
      `INSERT INTO newsletter_deliveries
         (newsletter_id, subscriber_id, status, attempts, last_error, updated_at)
       VALUES (?, ?, 'sending', 1, NULL, CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE
         attempts = IF(status = 'sent', attempts, attempts + 1),
         last_error = IF(status = 'sent', last_error, NULL),
         status = IF(status = 'sent', status, 'sending'),
         updated_at = IF(status = 'sent', updated_at, CURRENT_TIMESTAMP(3))`,
      [newsletter.id, subscriber.id],
    );
    const [deliveryRows] = await pool.execute(
      `SELECT status FROM newsletter_deliveries
       WHERE newsletter_id = ? AND subscriber_id = ?`,
      [newsletter.id, subscriber.id],
    );
    if (deliveryRows[0]?.status === 'sent') {
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
      await pool.execute(
        `UPDATE newsletter_deliveries
         SET status = 'sent', sent_at = CURRENT_TIMESTAMP(3), last_error = NULL,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE newsletter_id = ? AND subscriber_id = ?`,
        [newsletter.id, subscriber.id],
      );
      return { failed: false, skipped: false };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await pool.execute(
        `UPDATE newsletter_deliveries
         SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP(3)
         WHERE newsletter_id = ? AND subscriber_id = ?`,
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
      const [subscribers] = await pool.execute(
        `SELECT subscriber.id, subscriber.email, subscriber.unsubscribe_token
         FROM subscribers AS subscriber
         WHERE subscriber.status = 'active'
           AND subscriber.id > ?
           AND NOT EXISTS (
             SELECT 1
             FROM newsletter_deliveries AS delivery
             WHERE delivery.newsletter_id = ?
               AND delivery.subscriber_id = subscriber.id
               AND delivery.status = 'sent'
           )
         ORDER BY subscriber.id
         LIMIT ?`,
        [lastSubscriberId, newsletter.id, config.batchSize],
      );

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
      await pool.execute(
        `UPDATE newsletters SET updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND status = 'sending'`,
        [newsletter.id],
      );
    }

    const status = failedCount > 0 ? 'failed' : 'sent';
    await pool.execute(
      `UPDATE newsletters
       SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP(3) ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
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
          await pool.execute(
            `UPDATE newsletters
             SET status = 'failed', sent_at = NULL, updated_at = CURRENT_TIMESTAMP(3)
             WHERE id = ?`,
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
    processDueNewsletters,
  };
}

export { appendUnsubscribeLink, htmlPage, toPlainText };
