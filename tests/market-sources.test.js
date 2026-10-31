import assert from 'node:assert/strict';
import test from 'node:test';
import { MARKET_FEEDS, MARKET_INSTRUMENTS, fetchMarketObservations, parseMarketFeed } from '../src/marketSources.js';
import { crudePayload, fxPayload, jsonResponse, ratesPayload, snapDataFetch } from './fixtures/snapdata.js';

const now = new Date('2026-10-31T09:00:00Z');
const feed = (id) => MARKET_FEEDS.find((candidate) => candidate.id === id);

test('only verified, redistributable instruments are configured', () => {
  assert.deepEqual(MARKET_INSTRUMENTS.map((instrument) => instrument.id), [
    'UST2Y', 'UST10Y', 'BRENT', 'WTI', 'USDINR', 'EURUSD', 'GBPUSD', 'USDJPY',
  ]);
  assert.ok(!MARKET_FEEDS.some((candidate) => /gold|equity-indices/.test(candidate.url)));
});

test('parses Treasury yields and EIA crude from the verified SnapData envelopes', () => {
  const [ust2y, ust10y] = parseMarketFeed(ratesPayload(), feed('rates-world'), now);
  assert.equal(ust2y.ok, true);
  assert.deepEqual(
    [ust2y.instrument, ust2y.value, ust2y.previousClose, ust2y.change, ust2y.changePercent, ust2y.dataDate, ust2y.sourceId],
    ['UST2Y', 4.79, 4.77, 0.02, 0.4193, '2026-10-20', 'treasury'],
  );
  assert.equal(ust2y.sourceGeneratedAt.toISOString(), '2026-10-20T21:30:00.000Z');
  assert.deepEqual([ust10y.instrument, ust10y.value, ust10y.change], ['UST10Y', 5.12, -0.03]);

  const [brent, wti] = parseMarketFeed(crudePayload(), feed('crude-world'), now);
  assert.deepEqual([brent.instrument, brent.displayName, brent.value, brent.change], ['BRENT', 'Brent Spot (EIA)', 126.55, 0.77]);
  assert.deepEqual([wti.instrument, wti.value, wti.dataDate], ['WTI', 101.91, '2026-10-14']);
});

test('parses ECB-based FX pairs with per-instrument quote currencies', () => {
  const results = parseMarketFeed(fxPayload(), feed('fx-world'), now);
  const byId = Object.fromEntries(results.map((result) => [result.instrument, result]));

  assert.deepEqual(
    [byId.USDINR.value, byId.USDINR.previousClose, byId.USDINR.changePercent, byId.USDINR.unit, byId.USDINR.currency, byId.USDINR.sourceId],
    [94.9552, 95.2691, -0.3295, 'rate', 'INR', 'ecb'],
  );
  assert.deepEqual([byId.EURUSD.value, byId.EURUSD.currency], [1.1172, 'USD']);
  assert.deepEqual([byId.GBPUSD.value, byId.GBPUSD.currency], [1.3399, 'USD']);
  assert.deepEqual([byId.USDJPY.value, byId.USDJPY.currency], [157.2503, 'JPY']);
  assert.ok(results.every((result) => result.ok));
});

test('rejects monthly, estimated, or wrongly-unitised data', () => {
  assert.throws(
    () => parseMarketFeed({ ...fxPayload(), resolution: 'monthly' }, feed('fx-world'), now),
    { code: 'UNEXPECTED_RESOLUTION' },
  );
  assert.throws(
    () => parseMarketFeed(fxPayload({ unit: { quantity: 'percent', currency: 'USD' } }), feed('fx-world'), now),
    { code: 'UNEXPECTED_UNIT' },
  );
  assert.throws(
    () => parseMarketFeed(ratesPayload({ unit: { quantity: 'bps', currency: 'USD' } }), feed('rates-world'), now),
    { code: 'UNEXPECTED_UNIT' },
  );
  assert.throws(
    () => parseMarketFeed(fxPayload({ dataset: 'gold' }), feed('fx-world'), now),
    { code: 'UNEXPECTED_DATASET' },
  );
  const estimated = fxPayload();
  estimated.observations[2].status = 'estimated';
  const usdInr = parseMarketFeed(estimated, feed('fx-world'), now).find((result) => result.instrument === 'USDINR');
  assert.equal(usdInr.ok, false);
  assert.equal(usdInr.errorCode, 'UNUSABLE_STATUS');
});

test('rejects invalid values, dates and missing instruments per instrument', () => {
  const crude = crudePayload();
  crude.observations[0].value = 'not-a-number';
  const [brent, wti] = parseMarketFeed(crude, feed('crude-world'), now);
  assert.equal(brent.errorCode, 'INVALID_VALUE');
  assert.equal(wti.ok, true, 'a bad Brent row must not discard valid WTI data');

  const absurdFx = fxPayload();
  absurdFx.observations[2].value = 9.49;
  const absurdUsdInr = parseMarketFeed(absurdFx, feed('fx-world'), now).find((result) => result.instrument === 'USDINR');
  assert.equal(absurdUsdInr.errorCode, 'INVALID_VALUE');

  const futureRates = ratesPayload();
  futureRates.observations[1].date = '2026-11-30';
  assert.equal(parseMarketFeed(futureRates, feed('rates-world'), now)[0].errorCode, 'INVALID_DATE');

  const missing = parseMarketFeed(ratesPayload({ observations: [] }), feed('rates-world'), now);
  assert.ok(missing.every((result) => result.errorCode === 'MISSING_INSTRUMENT'));

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
    '/fx/world/': async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    },
  });
  const results = await fetchMarketObservations({ fetchImpl, timeoutMs: 1000, now: () => now });
  const byId = Object.fromEntries(results.map((result) => [result.instrument, result]));

  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(byId.UST2Y.ok, true);
  assert.equal(byId.UST10Y.ok, true);
  assert.match(byId.BRENT.error, /^HTTP_ERROR/);
  assert.equal(byId.WTI.ok, false);
  assert.match(byId.USDINR.error, /^TIMEOUT/);
  assert.match(byId.EURUSD.error, /^TIMEOUT/);
});

test('rejects non-JSON responses and passes a timeout signal to fetch', async () => {
  let signal;
  const fetchImpl = snapDataFetch({
    '/rates/world/': async (options) => {
      signal = options.signal;
      return jsonResponse('<html>maintenance</html>', { contentType: 'text/html' });
    },
    '/crude/world/': async () => jsonResponse('{not json'),
    '/fx/world/': async () => jsonResponse(fxPayload()),
  });
  const results = await fetchMarketObservations({ fetchImpl, timeoutMs: 1000, now: () => now });
  const byId = Object.fromEntries(results.map((result) => [result.instrument, result]));

  assert.ok(signal instanceof AbortSignal);
  assert.match(byId.UST2Y.error, /^INVALID_CONTENT_TYPE/);
  assert.match(byId.BRENT.error, /^INVALID_JSON/);
  assert.equal(byId.USDINR.ok, true);
});
