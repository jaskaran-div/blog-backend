import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketSnapshotService } from '../src/marketSnapshotService.js';
import { crudePayload, goldInPayload, jsonResponse, ratesPayload, snapDataFetch } from './fixtures/snapdata.js';

const config = {
  marketSnapshot: {
    requestTimeoutMs: 1000,
    staleAfterHours: 36,
    minIntervalMinutes: 10,
  },
};
const silentLogger = { info() {}, warn() {}, error() {} };

// Emulates the market snapshot SQL statements against in-memory state.
function createFakePool({ lockAvailable = true, recentRun = false } = {}) {
  const snapshots = new Map();
  const runs = [];
  const state = { snapshots, runs, lockHeld: false, released: 0, releasedWithError: 0 };

  async function query(sql, params = []) {
    if (sql.includes('pg_try_advisory_lock')) {
      state.lockHeld = lockAvailable;
      return { rows: [{ acquired: lockAvailable }] };
    }
    if (sql.includes('pg_advisory_unlock')) {
      state.lockHeld = false;
      return { rows: [{ pg_advisory_unlock: true }] };
    }
    if (sql.includes('FROM market_snapshot_runs') && sql.includes('make_interval(mins')) {
      return { rows: recentRun ? [{ id: 1 }] : [] };
    }
    if (sql.startsWith('INSERT INTO market_snapshot_runs')) {
      runs.push({ id: runs.length + 1, run_trigger: params[0], status: 'running', started_at: new Date() });
      return { rows: [{ id: runs.length }] };
    }
    if (sql.startsWith('UPDATE market_snapshot_runs')) {
      const run = runs.find((candidate) => candidate.id === params[0]);
      const status = params.length === 3 ? params[1] : 'failed';
      Object.assign(run, { status, finished_at: new Date(), details: JSON.parse(params.at(-1)) });
      return { rowCount: 1 };
    }
    if (sql.startsWith('DELETE FROM market_snapshot_runs')) {
      return { rowCount: 0 };
    }
    if (sql.includes('INSERT INTO market_snapshots') && sql.includes("'ok'")) {
      const [instrument, displayName, dataset, value, previousClose, change, changePercent, unit, currency,
        sourceId, sourceName, sourceUrl, sourceStatus, dataDate, filledFrom, sourceGeneratedAt] = params;
      const existing = snapshots.get(instrument);
      if (existing?.data_date && dataDate < existing.data_date) {
        return { rowCount: 0 };
      }
      snapshots.set(instrument, {
        instrument, display_name: displayName, dataset, value: String(value),
        previous_close: previousClose === null ? null : String(previousClose),
        change: change === null ? null : String(change),
        change_percent: changePercent === null ? null : String(changePercent),
        unit, currency, source_id: sourceId, source_name: sourceName, source_url: sourceUrl,
        source_status: sourceStatus, data_date: dataDate, filled_from: filledFrom,
        source_generated_at: sourceGeneratedAt, fetched_at: new Date(), last_attempt_at: new Date(),
        status: 'ok', last_error: null, consecutive_failures: 0,
      });
      return { rowCount: 1 };
    }
    if (sql.includes('INSERT INTO market_snapshots')) {
      const [instrument, displayName, dataset, error] = params;
      const existing = snapshots.get(instrument) ?? {
        instrument, display_name: displayName, dataset, value: null, fetched_at: null, data_date: null, consecutive_failures: 0,
      };
      snapshots.set(instrument, {
        ...existing,
        last_attempt_at: new Date(),
        status: 'error',
        last_error: error,
        consecutive_failures: existing.consecutive_failures + 1,
      });
      return { rowCount: 1 };
    }
    if (sql.includes('FROM market_snapshots WHERE instrument = ANY')) {
      return { rows: [...snapshots.values()].filter((row) => params[0].includes(row.instrument)) };
    }
    if (sql.includes('FROM market_snapshot_runs')) {
      return { rows: runs.filter((run) => run.status !== 'running').slice(-1) };
    }
    if (sql.includes('EXISTS (SELECT 1 FROM market_snapshots')) {
      return { rows: [{ present: [...snapshots.values()].some((row) => row.fetched_at) }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  }

  return {
    state,
    query,
    async connect() {
      return {
        query,
        release(error) {
          state.released += 1;
          if (error) state.releasedWithError += 1;
        },
      };
    },
  };
}

function healthyFetch() {
  return snapDataFetch({
    '/rates/world/': async () => jsonResponse(ratesPayload()),
    '/crude/world/': async () => jsonResponse(crudePayload()),
    '/gold/in/': async () => jsonResponse(goldInPayload()),
  });
}

test('refresh stores every instrument and records a succeeded run', async () => {
  const pool = createFakePool();
  const service = createMarketSnapshotService({ pool, config, fetchImpl: healthyFetch(), logger: silentLogger });

  const result = await service.refresh({ trigger: 'manual' });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.updated, 4);
  assert.deepEqual([...pool.state.snapshots.keys()].sort(), ['BRENT', 'GOLD_IN_24K', 'UST2Y', 'WTI']);
  assert.equal(pool.state.runs[0].status, 'succeeded');
  assert.equal(pool.state.runs[0].run_trigger, 'manual');
  assert.equal(pool.state.lockHeld, false);
  assert.equal(pool.state.released, 1);
  assert.equal(await service.hasSuccessfulSnapshot(), true);
});

test('a failing source preserves the last successful snapshot and other sources still update', async () => {
  const pool = createFakePool();
  await createMarketSnapshotService({ pool, config, fetchImpl: healthyFetch(), logger: silentLogger })
    .refresh({ force: true });
  const brentBefore = { ...pool.state.snapshots.get('BRENT') };

  const newerRates = ratesPayload();
  newerRates.observations[1] = { ...newerRates.observations[1], date: '2026-10-21', value: 4.81, prev_close: 4.79 };
  const failingCrude = snapDataFetch({
    '/rates/world/': async () => jsonResponse(newerRates),
    '/crude/world/': async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); },
    '/gold/in/': async () => jsonResponse({ ...goldInPayload(), observations: [] }),
  });
  const result = await createMarketSnapshotService({ pool, config, fetchImpl: failingCrude, logger: silentLogger })
    .refresh({ force: true });

  assert.equal(result.status, 'partial');
  assert.equal(result.updated, 1);
  const brent = pool.state.snapshots.get('BRENT');
  assert.equal(brent.value, brentBefore.value, 'Brent value must be preserved');
  assert.equal(brent.data_date, brentBefore.data_date);
  assert.equal(brent.fetched_at, brentBefore.fetched_at);
  assert.equal(brent.status, 'error');
  assert.match(brent.last_error, /^TIMEOUT/);
  assert.equal(brent.consecutive_failures, 1);
  assert.equal(pool.state.snapshots.get('UST2Y').value, '4.81');
  assert.equal(pool.state.snapshots.get('GOLD_IN_24K').value, '14804');
  assert.equal(pool.state.runs[1].status, 'partial');
});

test('older source data never replaces a newer stored observation', async () => {
  const pool = createFakePool();
  await createMarketSnapshotService({ pool, config, fetchImpl: healthyFetch(), logger: silentLogger })
    .refresh({ force: true });

  const olderRates = ratesPayload();
  olderRates.observations[1] = { ...olderRates.observations[1], date: '2026-10-19', value: 4.5 };
  const fetchImpl = snapDataFetch({
    '/rates/world/': async () => jsonResponse(olderRates),
    '/crude/world/': async () => jsonResponse(crudePayload()),
    '/gold/in/': async () => jsonResponse(goldInPayload()),
  });
  const result = await createMarketSnapshotService({ pool, config, fetchImpl, logger: silentLogger })
    .refresh({ force: true });

  assert.equal(result.status, 'partial');
  assert.equal(pool.state.snapshots.get('UST2Y').value, '4.79');
  assert.match(pool.state.snapshots.get('UST2Y').last_error, /^OLDER_DATA/);
});

test('refresh is skipped without fetching when another instance holds the lock or ran recently', async () => {
  for (const [options, reason] of [[{ lockAvailable: false }, 'locked'], [{ recentRun: true }, 'recent-run']]) {
    const pool = createFakePool(options);
    const fetchImpl = healthyFetch();
    const service = createMarketSnapshotService({ pool, config, fetchImpl, logger: silentLogger });

    assert.deepEqual(await service.refresh(), { status: 'skipped', reason });
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(pool.state.runs.length, 0);
    assert.equal(pool.state.released, 1);
    assert.equal(pool.state.lockHeld, false);
  }
});

test('latest snapshot reads stored rows only and reports unavailable, partial and stale states', async () => {
  const pool = createFakePool();
  let currentTime = new Date('2026-10-23T09:00:00Z');
  const fetchImpl = async () => {
    throw new Error('getLatestSnapshot must not call external APIs');
  };
  const reader = createMarketSnapshotService({ pool, config, fetchImpl, logger: silentLogger, now: () => currentTime });

  const empty = await reader.getLatestSnapshot();
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.realtime, false);
  assert.equal(empty.snapshotUpdatedAt, null);
  assert.deepEqual(empty.instruments.map((item) => item.status), ['unavailable', 'unavailable', 'unavailable', 'unavailable']);
  assert.ok(empty.instruments.every((item) => item.value === null && item.change === null));

  const partialFetch = snapDataFetch({
    '/rates/world/': async () => jsonResponse(ratesPayload()),
    '/crude/world/': async () => jsonResponse({}, { status: 500 }),
    '/gold/in/': async () => jsonResponse(goldInPayload()),
  });
  await createMarketSnapshotService({ pool, config, fetchImpl: partialFetch, logger: silentLogger }).refresh();
  const fetchedAt = pool.state.snapshots.get('UST2Y').fetched_at;
  currentTime = new Date(fetchedAt.getTime() + 60_000);

  const partial = await reader.getLatestSnapshot();
  assert.equal(partial.status, 'partial');
  const ust2y = partial.instruments.find((item) => item.id === 'UST2Y');
  assert.deepEqual(
    [ust2y.value, ust2y.previousClose, ust2y.change, ust2y.dataDate, ust2y.status, ust2y.source.id],
    [4.79, 4.77, 0.02, '2026-10-20', 'ok', 'treasury'],
  );
  const brent = partial.instruments.find((item) => item.id === 'BRENT');
  assert.equal(brent.status, 'unavailable');
  assert.equal(brent.value, null);
  assert.equal(brent.lastAttemptStatus, 'error');
  assert.equal(partial.snapshotUpdatedAt, fetchedAt.toISOString());
  assert.equal(partial.lastRun.status, 'partial');

  currentTime = new Date(fetchedAt.getTime() + 37 * 60 * 60 * 1000);
  const stale = await reader.getLatestSnapshot();
  assert.equal(stale.status, 'stale');
  assert.equal(stale.instruments.find((item) => item.id === 'UST2Y').status, 'stale');
  assert.equal(stale.instruments.find((item) => item.id === 'UST2Y').value, 4.79);
});
