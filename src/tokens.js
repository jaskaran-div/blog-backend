import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createVerificationToken() {
  return randomBytes(32).toString('base64url');
}

export function createUnsubscribeToken(subscriberId, unsubscribeToken, secret) {
  const payload = `${subscriberId}.${unsubscribeToken}`;
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function readUnsubscribeToken(token, secret) {
  if (typeof token !== 'string') {
    return null;
  }

  const [subscriberId, unsubscribeToken, signature, extra] = token.split('.');
  if (extra !== undefined
    || !UUID_PATTERN.test(subscriberId ?? '')
    || !UUID_PATTERN.test(unsubscribeToken ?? '')
    || !/^[A-Za-z0-9_-]{43}$/.test(signature ?? '')) {
    return null;
  }

  const expected = createHmac('sha256', secret).update(`${subscriberId}.${unsubscribeToken}`).digest();
  let provided;
  try {
    provided = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  return { subscriberId, unsubscribeToken };
}

export function isValidVerificationToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{40,50}$/.test(token);
}
