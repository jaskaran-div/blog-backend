import assert from 'node:assert/strict';
import test from 'node:test';
import { MARKET_FEEDS, fetchMarketObservations, parseMarketFeed } from '../src/marketSources.js';
import {
  crudePayload,
  goldInPayload,
  goldWorldMonthlyPayload,
  jsonResponse,
  ratesPayload,
  snapDataFetch,
} from './fixtures/snapdata.js';

const now = new Date('2026-10-23T09:00:00Z');
const feed = (id) => MARKET_FEEDS.find((candidate) => candidate.id === id);

test('parses UST2Y, Brent, WTI and IBJA 24K gold from the verified SnapData envelopes', () => {
  const [ust2y] = parseMarketFeed(ratesPayload(), feed('rates-world'), now);
  assert.equal(ust2y.ok, true);
  assert.equal(ust2y.instrument, 'UST2Y');
  assert.equal(ust2y.value, 4.79);
  assert.equal(ust2y.previousClose, 4.77);
  assert.equal(ust2y.change, 0.02);
  assert.equal(ust2y.changePercent, 0.4193);
  assert.equal(ust2y.dataDate, '2026-10-20');
  assert.equal(ust2y.sourceId, 'treasury');
  assert.equal(ust2y.sourceStatus, 'provisional');
  assert.equal(ust2y.sourceGeneratedAt.toISOString(), '2026-10-20T21:30:00.000Z');

  const [brent, wti] = parseMarketFeed(crudePayload(), feed('crude-world'), now);
  assert.deepEqual([brent.instrument, brent.value, brent.change], ['BRENT', 126.55, 0.77]);
  assert.deepEqual([wti.instrument, wti.value, wti.dataDate], ['WTI', 101.91, '2026-10-14']);

  const [gold] = parseMarketFeed(goldInPayload(), feed('gold-in'), now);
  assert.deepEqual([gold.instrument, gold.value, gold.currency, gold.unit], ['GOLD_IN_24K', 14804, 'INR', 'gram']);
});

test('rejects monthly or estimated gold data instead of presenting it as spot gold', () => {
  const goldFeed = feed('gold-in');
  assert.throws(
    () => parseMarketFeed(goldWorldMonthlyPayload(), goldFeed, now),
    { code: 'UNEXPECTED_DATASET' },
  );
  assert.throws(
    () => parseMarketFeed({ ...goldInPayload(), resolution: 'monthly' }, goldFeed, now),
    { code: 'UNEXPECTED_RESOLUTION' },
  );
  const payload = goldInPayload();
  payload.observations[1].status = 'estimated';
  const [result] = parseMarketFeed(payload, goldFeed, now);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'UNUSABLE_STATUS');
});

test('rejects invalid values, units, dates and missing instruments per instrument', () => {
  const crude = crudePayload();
  crude.observations[0].value = 'not-a-number';
  const [brent, wti] = parseMarketFeed(crude, feed('crude-world'), now);
  assert.equal(brent.ok, false);
  assert.equal(brent.errorCode, 'INVALID_VALUE');
  assert.equal(wti.ok, true, 'a bad Brent row must not discard valid WTI data');

  assert.throws(
    () => parseMarketFeed(ratesPayload({ unit: { quantity: 'bps', currency: 'USD' } }), feed('rates-world'), now),
    { code: 'UNEXPECTED_UNIT' },
  );

  const futureRates = ratesPayload();
  futureRates.observations[1].date = '2026-11-30';
  assert.equal(parseMarketFeed(futureRates, feed('rates-world'), now)[0].errorCode, 'INVALID_DATE');

  const missingRates = ratesPayload({ observations: [] });
  assert.equal(parseMarketFeed(missingRates, feed('rates-world'), now)[0].errorCode, 'MISSING_INSTRUMENT');

  const noPrevious = ratesPayload();
  noPrevious.observations[1].prev_close = null;
  noPrevious.observations[1].change_pct = null;
  const [withoutPrevious] = parseMarketFeed(noPrevious, feed('rates-world'), now);
  assert.equal(withoutPrevious.ok, true);
  assert.equal(withoutPrevious.change, null);
  assert.equal(withoutPrevious.changePercent, null);
});

test('one failing or timed-out source does not prevent other sources from succeeding', async () => {
  const fetchImpl = snapDataFetch({
    '/rates/world/': async () => jsonResponse(ratesPayload()),
    '/crude/world/': async () => jsonResponse({ error: 'upstream' }, { status: 502 }),
    '/gold/in/': async () => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    },
  });
  const results = await fetchMarketObservations({ fetchImpl, timeoutMs: 1000, now: () => now });

  assert.equal(fetchImpl.calls.length, 3);
  const byId = Object.fromEntries(results.map((result) => [result.instrument, result]));
  assert.equal(byId.UST2Y.ok, true);
  assert.equal(byId.BRENT.ok, false);
  assert.match(byId.BRENT.error, /^HTTP_ERROR/);
  assert.equal(byId.WTI.ok, false);
  assert.equal(byId.GOLD_IN_24K.ok, false);
  assert.match(byId.GOLD_IN_24K.error, /^TIMEOUT/);
});

test('rejects non-JSON responses and passes a timeout signal to fetch', async () => {
  let signal;
  const fetchImpl = snapDataFetch({
    '/rates/world/': async (options) => {
      signal = options.signal;
      return jsonResponse('<html>maintenance</html>', { contentType: 'text/html' });
    },
    '/crude/world/': async () => jsonResponse('{not json'),
    '/gold/in/': async () => jsonResponse(goldInPayload()),
  });
  const results = await fetchMarketObservations({ fetchImpl, timeoutMs: 1000, now: () => now });
  const byId = Object.fromEntries(results.map((result) => [result.instrument, result]));

  assert.ok(signal instanceof AbortSignal);
  assert.match(byId.UST2Y.error, /^INVALID_CONTENT_TYPE/);
  assert.match(byId.BRENT.error, /^INVALID_JSON/);
  assert.equal(byId.GOLD_IN_24K.ok, true);
});
