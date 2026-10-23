import cron from 'node-cron';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MARKET_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
    marketSnapshot: loadMarketSnapshotConfig(env),
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

function booleanFlag(env, name, fallback) {
  const value = env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  if (['true', '1', 'yes'].includes(value)) {
    return true;
  }
  if (['false', '0', 'no'].includes(value)) {
    return false;
  }
  throw new Error(`${name} must be true or false.`);
}

export function loadMarketSnapshotConfig(env = process.env) {
  const timezone = env.MARKET_SNAPSHOT_TIMEZONE?.trim() || 'Asia/Kolkata';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error('MARKET_SNAPSHOT_TIMEZONE must be a valid IANA timezone.');
  }

  const times = [...new Set((env.MARKET_SNAPSHOT_TIMES ?? '')
    .split(',')
    .map((time) => time.trim())
    .filter(Boolean))];
  for (const time of times) {
    if (!MARKET_TIME_PATTERN.test(time)) {
      throw new Error('MARKET_SNAPSHOT_TIMES must be a comma-separated list of 24-hour HH:MM times.');
    }
  }

  const days = env.MARKET_SNAPSHOT_DAYS?.trim() || '*';
  if (!cron.validate(`0 0 * * ${days}`)) {
    throw new Error('MARKET_SNAPSHOT_DAYS must be a valid cron day-of-week field, for example * or 1-5.');
  }

  const minIntervalMinutes = Math.min(positiveInteger(env, 'MARKET_SNAPSHOT_MIN_INTERVAL_MINUTES', 10), 720);
  const minutesOfDay = times
    .map((time) => {
      const [hour, minute] = time.split(':').map(Number);
      return hour * 60 + minute;
    })
    .sort((first, second) => first - second);
  for (let index = 0; index < minutesOfDay.length && minutesOfDay.length > 1; index += 1) {
    const next = minutesOfDay[(index + 1) % minutesOfDay.length] + (index + 1 === minutesOfDay.length ? 1440 : 0);
    if (next - minutesOfDay[index] <= minIntervalMinutes) {
      throw new Error('MARKET_SNAPSHOT_TIMES entries must be further apart than MARKET_SNAPSHOT_MIN_INTERVAL_MINUTES.');
    }
  }

  return {
    timezone,
    times,
    days,
    cronExpressions: times.map((time) => {
      const [hour, minute] = time.split(':').map(Number);
      return `${minute} ${hour} * * ${days}`;
    }),
    requestTimeoutMs: Math.min(positiveInteger(env, 'MARKET_SNAPSHOT_TIMEOUT_MS', 10_000), 60_000),
    // Weekday-only schedules leave a weekend gap, so their default threshold covers Friday to Monday.
    staleAfterHours: positiveInteger(env, 'MARKET_SNAPSHOT_STALE_AFTER_HOURS', days === '*' ? 36 : 84),
    minIntervalMinutes,
    bootstrapIfEmpty: booleanFlag(env, 'MARKET_SNAPSHOT_BOOTSTRAP_IF_EMPTY', true),
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
