// SnapData publishes daily end-of-day/benchmark values (not intraday quotes). Each feed is
// checked against the envelope verified on 2026-10-23 before any value is accepted.
const SNAPDATA_BASE_URL = 'https://snapdata.dev/api/v1';
const MAX_RESPONSE_BYTES = 1_000_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// SnapData marks gap-filled or modelled values this way; they are never shown as market levels.
const REJECTED_OBSERVATION_STATUSES = new Set(['missing', 'estimated']);

export const MARKET_FEEDS = [
  {
    id: 'rates-world',
    url: `${SNAPDATA_BASE_URL}/rates/world/latest.json`,
    dataset: 'rates',
    scope: 'world',
    unit: 'percent',
    currency: 'USD',
    instruments: [
      { id: 'UST2Y', sourceInstrument: 'UST2Y', displayName: '2Y Treasury Yield', min: -5, max: 30 },
    ],
  },
  {
    id: 'crude-world',
    url: `${SNAPDATA_BASE_URL}/crude/world/latest.json`,
    dataset: 'crude',
    scope: 'world',
    unit: 'barrel',
    currency: 'USD',
    instruments: [
      { id: 'BRENT', sourceInstrument: 'BRENT', displayName: 'Brent Crude', min: 0, max: 1000 },
      // WTI settled below zero in April 2020, so negative values are valid.
      { id: 'WTI', sourceInstrument: 'WTI', displayName: 'WTI Crude', min: -200, max: 1000 },
    ],
  },
  {
    // The world gold feed is a monthly World Bank average, so the daily IBJA benchmark is used instead.
    id: 'gold-in',
    url: `${SNAPDATA_BASE_URL}/gold/in/latest.json`,
    dataset: 'gold',
    scope: 'in',
    unit: 'gram',
    currency: 'INR',
    instruments: [
      { id: 'GOLD_IN_24K', sourceInstrument: 'XAU.24K', displayName: 'Gold 24K (IBJA)', min: 100, max: 1_000_000 },
    ],
  },
];

export function instrumentsForFeeds(feeds) {
  return feeds.flatMap((feed) => feed.instruments.map((instrument) => ({
    ...instrument,
    dataset: feed.dataset,
    unit: feed.unit,
    currency: feed.currency,
  })));
}

export const MARKET_INSTRUMENTS = instrumentsForFeeds(MARKET_FEEDS);

export class MarketDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarketDataError';
    this.code = code;
  }
}

function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function parseMarketFeed(payload, feed, now = new Date()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new MarketDataError('INVALID_PAYLOAD', 'Response is not a JSON object.');
  }
  if (typeof payload.schema_version !== 'string' || !payload.schema_version.startsWith('1.')) {
    throw new MarketDataError('UNSUPPORTED_SCHEMA', `Unsupported schema version: ${String(payload.schema_version)}.`);
  }
  if (payload.dataset !== feed.dataset || payload.scope !== feed.scope) {
    throw new MarketDataError('UNEXPECTED_DATASET', `Expected ${feed.dataset}/${feed.scope}.`);
  }
  if (payload.resolution !== 'daily') {
    throw new MarketDataError('UNEXPECTED_RESOLUTION', `Expected daily data, received ${String(payload.resolution)}.`);
  }
  if (payload.unit?.quantity !== feed.unit || payload.unit?.currency !== feed.currency) {
    throw new MarketDataError('UNEXPECTED_UNIT', `Expected ${feed.currency} per ${feed.unit}.`);
  }
  if (!Array.isArray(payload.observations)) {
    throw new MarketDataError('INVALID_PAYLOAD', 'Response has no observations array.');
  }

  const generatedAt = typeof payload.generated_at === 'string' && !Number.isNaN(Date.parse(payload.generated_at))
    ? new Date(payload.generated_at)
    : null;
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  // Allow for source timezones ahead of UTC, but reject dates clearly in the future.
  const latestAllowedDate = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  return feed.instruments.map((instrument) => {
    try {
      const matches = payload.observations.filter((row) => row?.instrument === instrument.sourceInstrument);
      if (matches.length !== 1) {
        throw new MarketDataError('MISSING_INSTRUMENT', `Expected one ${instrument.sourceInstrument} observation, found ${matches.length}.`);
      }
      const [observation] = matches;
      if (typeof observation.status !== 'string' || REJECTED_OBSERVATION_STATUSES.has(observation.status)) {
        throw new MarketDataError('UNUSABLE_STATUS', `${instrument.sourceInstrument} observation status is ${String(observation.status)}.`);
      }
      const value = finiteOrNull(observation.value);
      if (value === null || value < instrument.min || value > instrument.max) {
        throw new MarketDataError('INVALID_VALUE', `${instrument.sourceInstrument} value is missing or outside the expected range.`);
      }
      if (!isValidDate(observation.date) || observation.date > latestAllowedDate) {
        throw new MarketDataError('INVALID_DATE', `${instrument.sourceInstrument} has an invalid observation date.`);
      }
      const filledFrom = observation.filled_from == null ? null : observation.filled_from;
      if (filledFrom !== null && (!isValidDate(filledFrom) || filledFrom > observation.date)) {
        throw new MarketDataError('INVALID_DATE', `${instrument.sourceInstrument} has an invalid filled_from date.`);
      }

      let previousClose = finiteOrNull(observation.prev_close);
      if (previousClose !== null && (previousClose < instrument.min || previousClose > instrument.max)) {
        previousClose = null;
      }
      const change = previousClose === null ? null : round(value - previousClose, 6);
      const sourceChangePercent = finiteOrNull(observation.change_pct);
      const changePercent = previousClose === null
        ? null
        : sourceChangePercent ?? (previousClose === 0 ? null : round((change / previousClose) * 100, 6));
      const source = sources.find((candidate) => candidate?.id === observation.source) ?? sources[0] ?? {};
      if (typeof source.id !== 'string' || !source.id) {
        throw new MarketDataError('MISSING_SOURCE', `${instrument.sourceInstrument} has no source attribution.`);
      }

      return {
        ok: true,
        instrument: instrument.id,
        displayName: instrument.displayName,
        dataset: feed.dataset,
        value,
        previousClose,
        change,
        changePercent,
        unit: feed.unit,
        currency: feed.currency,
        sourceId: source.id.slice(0, 40),
        sourceName: typeof source.name === 'string' ? source.name.slice(0, 200) : null,
        sourceUrl: typeof source.url === 'string' && /^https:\/\//.test(source.url) ? source.url.slice(0, 300) : null,
        sourceStatus: observation.status.slice(0, 40),
        dataDate: observation.date,
        filledFrom,
        sourceGeneratedAt: generatedAt,
      };
    } catch (error) {
      return failureFor(instrument, feed, error);
    }
  });
}

function failureFor(instrument, feed, error) {
  const code = error instanceof MarketDataError ? error.code : (error?.name === 'TimeoutError' ? 'TIMEOUT' : 'FETCH_FAILED');
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    instrument: instrument.id,
    displayName: instrument.displayName,
    dataset: feed.dataset,
    error: `${code}: ${message}`.slice(0, 500),
    errorCode: code,
  };
}

async function fetchFeedPayload(feed, { fetchImpl, timeoutMs }) {
  const response = await fetchImpl(feed.url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new MarketDataError('HTTP_ERROR', `${feed.url} returned HTTP ${response.status}.`);
  }
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (!contentType.includes('json')) {
    throw new MarketDataError('INVALID_CONTENT_TYPE', `${feed.url} returned ${contentType || 'no content type'}.`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new MarketDataError('RESPONSE_TOO_LARGE', `${feed.url} response exceeded ${MAX_RESPONSE_BYTES} bytes.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new MarketDataError('INVALID_JSON', `${feed.url} returned invalid JSON.`);
  }
}

// Fetches every feed independently; one failing feed only produces failure results for its own instruments.
export async function fetchMarketObservations({ fetchImpl = fetch, timeoutMs, feeds = MARKET_FEEDS, now = () => new Date() }) {
  const results = await Promise.all(feeds.map(async (feed) => {
    try {
      const payload = await fetchFeedPayload(feed, { fetchImpl, timeoutMs });
      return parseMarketFeed(payload, feed, now());
    } catch (error) {
      return feed.instruments.map((instrument) => failureFor(instrument, feed, error));
    }
  }));
  return results.flat();
}
