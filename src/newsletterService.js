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

function dueNewsletterClaimSql() {
  return `
    with due as (
      select id
      from public.newsletters
      where (status = 'scheduled' and send_at <= now())
         or (status = 'sending' and send_at <= now()
             and updated_at < now() - ($1::integer * interval '1 minute'))
      order by send_at, id
      for update skip locked
      limit 1
    )
    update public.newsletters as newsletter
    set status = 'sending', updated_at = now()
    from due
    where newsletter.id = due.id
    returning newsletter.id, newsletter.title, newsletter.subject,
              newsletter.html_content, newsletter.send_at`;
}

export function createNewsletterService({ pool, emailService, config, logger = console }) {
  async function subscribe(inputEmail) {
    if (typeof inputEmail !== 'string' || !isValidEmail(inputEmail.trim())) {
      const error = new Error('Enter a valid email address.');
      error.statusCode = 400;
      throw error;
    }

    const email = normalizeEmail(inputEmail);
    const { rows } = await pool.query(
      `insert into public.subscribers
         (email, status, verification_token, unsubscribe_token, verified_at, subscribed_at, unsubscribed_at)
       values ($1, 'active', null, gen_random_uuid(), null, now(), null)
       on conflict (email) do update
         set status = 'active',
             verification_token = null,
             unsubscribe_token = gen_random_uuid(),
             verified_at = null,
             subscribed_at = now(),
             unsubscribed_at = null
       where public.subscribers.status in ('pending', 'unsubscribed')
       returning id, email, status`,
      [email],
    );

    return { message: 'You are subscribed to the weekly newsletter.' };
  }

  async function verify(token) {
    if (!isValidVerificationToken(token)) {
      return { ok: false };
    }

    const { rowCount } = await pool.query(
      `update public.subscribers
       set status = 'active',
           verified_at = now(),
           subscribed_at = now(),
           verification_token = null,
           unsubscribe_token = gen_random_uuid()
       where verification_token = $1 and status = 'pending'`,
      [token],
    );
    return { ok: rowCount === 1 };
  }

  async function unsubscribe(token) {
    const tokenClaims = readUnsubscribeToken(token, config.tokenSecret);
    if (!tokenClaims) {
      return { ok: false };
    }

    const { rowCount } = await pool.query(
      `update public.subscribers
       set status = 'unsubscribed',
           unsubscribed_at = coalesce(unsubscribed_at, now()),
           verification_token = null
       where id = $1 and unsubscribe_token = $2 and status = 'active'`,
      [tokenClaims.subscriberId, tokenClaims.unsubscribeToken],
    );

    if (rowCount === 1) {
      return { ok: true };
    }

    const existing = await pool.query(
      `select 1 from public.subscribers
       where id = $1 and unsubscribe_token = $2 and status = 'unsubscribed'`,
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
    const { rows } = await pool.query(dueNewsletterClaimSql(), [config.staleSendMinutes]);
    return rows[0] ?? null;
  }

  async function sendOneRecipient(newsletter, subscriber) {
    const { rows } = await pool.query(
      `insert into public.newsletter_deliveries
         (newsletter_id, subscriber_id, status, attempts, last_error, updated_at)
       values ($1, $2, 'sending', 1, null, now())
       on conflict (newsletter_id, subscriber_id) do update
         set status = 'sending',
             attempts = public.newsletter_deliveries.attempts + 1,
             last_error = null,
             updated_at = now()
       where public.newsletter_deliveries.status <> 'sent'
       returning status`,
      [newsletter.id, subscriber.id],
    );
    if (rows.length === 0) {
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
        `update public.newsletter_deliveries
         set status = 'sent', sent_at = now(), last_error = null, updated_at = now()
         where newsletter_id = $1 and subscriber_id = $2`,
        [newsletter.id, subscriber.id],
      );
      return { failed: false, skipped: false };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await pool.query(
        `update public.newsletter_deliveries
         set status = 'failed', last_error = $3, updated_at = now()
         where newsletter_id = $1 and subscriber_id = $2`,
        [newsletter.id, subscriber.id, errorMessage.slice(0, 1000)],
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
      const { rows: subscribers } = await pool.query(
        `        select subscriber.id, subscriber.email, subscriber.unsubscribe_token
         from public.subscribers as subscriber
         where subscriber.status = 'active'
           and subscriber.id > $2
           and not exists (
             select 1
             from public.newsletter_deliveries as delivery
             where delivery.newsletter_id = $1
               and delivery.subscriber_id = subscriber.id
               and delivery.status = 'sent'
           )
         order by subscriber.id
         limit $3`,
        [newsletter.id, lastSubscriberId, config.batchSize],
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
      await pool.query(
        `update public.newsletters set updated_at = now() where id = $1 and status = 'sending'`,
        [newsletter.id],
      );
    }

    const status = failedCount > 0 ? 'failed' : 'sent';
    await pool.query(
      `update public.newsletters
       set status = $2, sent_at = case when $2 = 'sent' then now() else null end, updated_at = now()
       where id = $1`,
      [newsletter.id, status],
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
      const newsletter = await claimNextDueNewsletter();
      if (!newsletter) {
        break;
      }

      claimedCount += 1;
      try {
        await sendNewsletter(newsletter);
      } catch (error) {
        logger.error('Newsletter campaign failed', {
          newsletterId: newsletter.id,
          error: error instanceof Error ? error.message : String(error),
        });
        await pool.query(
          `update public.newsletters set status = 'failed', sent_at = null, updated_at = now() where id = $1`,
          [newsletter.id],
        );
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
