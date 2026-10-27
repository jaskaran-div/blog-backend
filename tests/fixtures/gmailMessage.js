// Builds Gmail API `format=full` messages shaped like the real multipart/related news emails.
export const SENDER = 'neil.crammond@zenithwavecapital.com';
export const IMAGE_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');

const b64 = (value) => Buffer.from(value, 'utf8').toString('base64url');

export function authResults(domain = 'zenithwavecapital.com', server = 'mx.google.com') {
  return `${server}; dkim=pass header.i=@${domain} header.s=s1 header.b=abc; spf=pass smtp.mailfrom=${domain}; dmarc=pass (p=NONE) header.from=${domain}`;
}

export function buildMessage({
  id = 'msg0001',
  subject = 'Morning Briefing – Monday 26.10: Fed Week',
  from = `Neil Crammond <${SENDER}>`,
  date = 'Mon, 26 Oct 2026 13:05:00 +0530',
  html = `<html><head><title>x</title><style>p{color:red}</style></head><body>
<table width="600" cellpadding="0"><tr><td style="color:#333;padding:8px">
<h2>Fed Week</h2><p>Markets <strong>rally</strong> ahead of the FOMC &amp; ECB.</p>
<img src="cid:image001.png@01DB" alt="Chart" width="600">
<p><a href="https://example.com/report" onclick="steal()">Full report</a></p>
<script>alert(1)</script></td></tr></table></body></html>`,
  extraHeaders = [{ name: 'Authentication-Results', value: authResults() }],
  imageParts = [{ contentId: '<image001.png@01DB>', attachmentId: 'att-1', filename: 'image001.png' }],
} = {}) {
  return {
    id,
    internalDate: String(Date.parse('2026-10-26T07:35:00Z')),
    payload: {
      mimeType: 'multipart/related',
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
        { name: 'Date', value: date },
        ...extraHeaders,
      ],
      parts: [
        {
          mimeType: 'multipart/alternative',
          headers: [],
          parts: [
            {
              mimeType: 'text/plain',
              headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }],
              body: { data: b64('Plain version') },
            },
            {
              mimeType: 'text/html',
              headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }],
              body: { data: b64(html) },
            },
          ],
        },
        ...imageParts.map(({ contentId, attachmentId, filename }) => ({
          mimeType: 'image/png',
          filename,
          headers: [
            { name: 'Content-Type', value: `image/png; name="${filename}"` },
            { name: 'Content-Disposition', value: `inline; filename="${filename}"` },
            { name: 'Content-ID', value: contentId },
          ],
          body: { attachmentId, size: IMAGE_BYTES.length },
        })),
      ],
    },
  };
}
