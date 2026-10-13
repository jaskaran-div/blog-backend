const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveInteger(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function nonNegativeInteger(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const databaseConfig = loadDatabaseConfig(env);
  const emailConfig = loadEmailConfig(env);
  const verificationSecret = required(env, 'NEWSLETTER_TOKEN_SECRET');
  if (Buffer.byteLength(verificationSecret, 'utf8') < 32) {
    throw new Error('NEWSLETTER_TOKEN_SECRET must contain at least 32 bytes.');
  }
  const adminToken = required(env, 'NEWSLETTER_ADMIN_TOKEN');
  if (Buffer.byteLength(adminToken, 'utf8') < 32) {
    throw new Error('NEWSLETTER_ADMIN_TOKEN must contain at least 32 bytes.');
  }

  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (allowedOrigins.length === 0) {
    throw new Error('ALLOWED_ORIGINS must contain at least one frontend origin.');
  }
  for (const origin of allowedOrigins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('Each ALLOWED_ORIGINS entry must be a valid origin.');
    }
    if (origin !== parsed.origin || !['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Each ALLOWED_ORIGINS entry must be an origin without a path, query, or fragment.');
    }
  }

  const apiPublicUrl = required(env, 'NEWSLETTER_API_PUBLIC_URL').replace(/\/+$/, '');
  const siteUrl = required(env, 'NEWSLETTER_SITE_URL').replace(/\/+$/, '');
  for (const [name, value] of [['NEWSLETTER_API_PUBLIC_URL', apiPublicUrl], ['NEWSLETTER_SITE_URL', siteUrl]]) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`${name} must be a valid http or https URL.`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash) {
      throw new Error(`${name} must be a public http or https origin without credentials, path, query, or fragment.`);
    }
  }

  const configuredTrustProxyHops = nonNegativeInteger(
    env,
    'TRUST_PROXY_HOPS',
    env.RENDER_EXTERNAL_URL ? 1 : 0,
  );
  const trustProxyHops = env.RENDER_EXTERNAL_URL
    ? Math.max(1, configuredTrustProxyHops)
    : configuredTrustProxyHops;

  return {
    ...databaseConfig,
    ...emailConfig,
    nodeEnv: env.NODE_ENV ?? 'development',
    trustProxyHops,
    port: positiveInteger(env, 'PORT', 4000),
    siteUrl,
    apiPublicUrl,
    allowedOrigins,
    tokenSecret: verificationSecret,
    adminToken,
    cronSchedule: env.NEWSLETTER_CRON_SCHEDULE?.trim() || '* * * * *',
    batchSize: Math.min(positiveInteger(env, 'NEWSLETTER_BATCH_SIZE', 50), 500),
    sendConcurrency: Math.min(positiveInteger(env, 'NEWSLETTER_SEND_CONCURRENCY', 5), 10),
    staleSendMinutes: positiveInteger(env, 'NEWSLETTER_STALE_SEND_MINUTES', 30),
  };
}

export function loadDatabaseConfig(env = process.env) {
  const databaseUrl = required(env, 'DATABASE_URL');
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }
  if (!parsed.hostname
    || !parsed.username
    || !parsed.pathname || parsed.pathname === '/') {
    throw new Error('DATABASE_URL must include a PostgreSQL protocol, host, username, and database name.');
  }
  return { databaseUrl };
}

export function loadEmailConfig(env = process.env) {
  const awsAccessKeyId = env.AWS_ACCESS_KEY_ID?.trim() || '';
  const awsSecretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim() || '';
  const awsSessionToken = env.AWS_SESSION_TOKEN?.trim() || '';
  if (Boolean(awsAccessKeyId) !== Boolean(awsSecretAccessKey)) {
    throw new Error('Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or leave both empty to use the AWS credential provider chain.');
  }
  if (awsSessionToken && !awsAccessKeyId) {
    throw new Error('AWS_SESSION_TOKEN requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
  }

  const sesFromEmail = required(env, 'SES_FROM_EMAIL');
  if (!EMAIL_PATTERN.test(sesFromEmail)) {
    throw new Error('SES_FROM_EMAIL must be a valid email address.');
  }
  const sesFromName = env.SES_FROM_NAME?.trim() || 'ISFT';
  if (/[\r\n<>]/.test(sesFromName)) {
    throw new Error('SES_FROM_NAME must not contain line breaks or angle brackets.');
  }

  return {
    awsRegion: env.AWS_REGION?.trim() || 'ap-southeast-2',
    awsAccessKeyId,
    awsSecretAccessKey,
    awsSessionToken,
    sesFromEmail,
    sesFromName,
    sesConfigurationSet: env.SES_CONFIGURATION_SET?.trim() || undefined,
  };
}
