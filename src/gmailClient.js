// Minimal read-only Gmail REST client. Uses an OAuth refresh token with the
// https://www.googleapis.com/auth/gmail.readonly scope; it never modifies the mailbox.
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users';
const REQUEST_TIMEOUT_MS = 15_000;

export class GmailError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'GmailError';
    this.status = status;
    this.code = code ?? 'GMAIL_ERROR';
  }
}

export function createGmailClient({ clientId, clientSecret, refreshToken, user = 'me' }, { fetchImpl = fetch } = {}) {
  let cachedToken = null;

  async function accessToken() {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
      return cachedToken.value;
    }
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.access_token !== 'string') {
      // Never include the response body: it can echo client details.
      throw new GmailError('Gmail OAuth token refresh failed.', {
        status: response.status,
        code: typeof body.error === 'string' ? `GMAIL_OAUTH_${body.error.toUpperCase()}` : 'GMAIL_OAUTH_FAILED',
      });
    }
    cachedToken = {
      value: body.access_token,
      expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    };
    return cachedToken.value;
  }

  async function request(path, searchParams) {
    const url = new URL(`${API_BASE}/${encodeURIComponent(user)}${path}`);
    for (const [key, value] of Object.entries(searchParams ?? {})) {
      url.searchParams.set(key, String(value));
    }
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new GmailError(`Gmail API request failed with status ${response.status}.`, { status: response.status });
    }
    return response.json();
  }

  return {
    async listMessageIds(query, maxResults = 25) {
      const body = await request('/messages', { q: query, maxResults });
      return (body.messages ?? []).map((message) => message.id).filter((id) => typeof id === 'string');
    },
    getMessage(id) {
      return request(`/messages/${encodeURIComponent(id)}`, { format: 'full' });
    },
    async getAttachment(messageId, attachmentId) {
      const body = await request(
        `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      );
      return Buffer.from(body.data ?? '', 'base64url');
    },
  };
}
