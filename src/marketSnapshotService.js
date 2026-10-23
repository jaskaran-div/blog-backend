import { MARKET_FEEDS, fetchMarketObservations, instrumentsForFeeds } from './marketSources.js';

// Separate from the newsletter lock names, so market refreshes never block campaign sends.
const REFRESH_LOCK_NAME = 'derivion:market-snapshot-refresh';
const RUN_RETENTION_DAYS = 90;

function numberOrNull(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOnly(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    // pg returns DATE columns as local-midnight Date objects.
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

function isoOrNull(value) {
  if (!value) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function createMarketSnapshotService({
  pool,
  config,
  fetchImpl = fetch,
  logger = console,
  now = () => new Date(),
  feeds = MARKET_FEEDS,
}) {
  const settings = config.marketSnapshot;
  const instruments = instrumentsForFeeds(feeds);

  async function saveSuccess(client, result) {
    const { rowCount } = await client.query(
      `INSERT INTO market_snapshots
         (instrument, display_name, dataset, value, previous_close, change, change_percent,
          unit, currency, source_id, source_name, source_url, source_status, data_date,
          filled_from, source_generated_at, fetched_at, last_attempt_at, status,
          last_error, last_error_at, consecutive_failures)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
               NOW(), NOW(), 'ok', NULL, NULL, 0)
       ON CONFLICT (instrument) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         dataset = EXCLUDED.dataset,
         value = EXCLUDED.value,
         previous_close = EXCLUDED.previous_close,
         change = EXCLUDED.change,
         change_percent = EXCLUDED.change_percent,
         unit = EXCLUDED.unit,
         currency = EXCLUDED.currency,
         source_id = EXCLUDED.source_id,
         source_name = EXCLUDED.source_name,
         source_url = EXCLUDED.source_url,
         source_status = EXCLUDED.source_status,
         data_date = EXCLUDED.data_date,
         filled_from = EXCLUDED.filled_from,
         source_generated_at = EXCLUDED.source_generated_at,
         fetched_at = NOW(),
         last_attempt_at = NOW(),
         status = 'ok',
         last_error = NULL,
         last_error_at = NULL,
         consecutive_failures = 0
       WHERE market_snapshots.data_date IS NULL
         OR EXCLUDED.data_date >= market_snapshots.data_date`,
      [
        result.instrument,
        result.displayName,
        result.dataset,
        result.value,
        result.previousClose,
        result.change,
        result.changePercent,
        result.unit,
        result.currency,
        result.sourceId,
        result.sourceName,
        result.sourceUrl,
        result.sourceStatus,
        result.dataDate,
        result.filledFrom,
        result.sourceGeneratedAt,
      ],
    );
    if (rowCount === 0) {
      // Never replace a stored observation with an older one.
      await saveFailure(client, {
        ...result,
        errorCode: 'OLDER_DATA',
        error: `OLDER_DATA: Source returned ${result.dataDate}, older than the stored snapshot.`,
      });
      return false;
    }
    return true;
  }

  async function saveFailure(client, result) {
    await client.query(
      `INSERT INTO market_snapshots
         (instrument, display_name, dataset, last_attempt_at, status, last_error,
          last_error_at, consecutive_failures)
       VALUES ($1, $2, $3, NOW(), 'error', $4, NOW(), 1)
       ON CONFLICT (instrument) DO UPDATE SET
         last_attempt_at = NOW(),
         status = 'error',
         last_error = EXCLUDED.last_error,
         last_error_at = NOW(),
         consecutive_failures = market_snapshots.consecutive_failures + 1`,
      [result.instrument, result.displayName, result.dataset, result.error.slice(0, 500)],
    );
  }

  async function refresh({ trigger = 'scheduled', force = false } = {}) {
    const client = await pool.connect();
    let locked = false;
    let releaseError;
    let runId;
    try {
      const lockResult = await client.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
        [REFRESH_LOCK_NAME],
      );
      locked = lockResult.rows[0]?.acquired === true;
      if (!locked) {
        logger.info('Market snapshot refresh skipped; another instance is already refreshing.', { trigger });
        return { status: 'skipped', reason: 'locked' };
      }

      if (!force) {
        // Guards against a second instance repeating a refresh that just finished.
        const recent = await client.query(
          `SELECT id FROM market_snapshot_runs
           WHERE started_at > NOW() - make_interval(mins => $1)
           ORDER BY started_at DESC LIMIT 1`,
          [settings.minIntervalMinutes],
        );
        if (recent.rows.length > 0) {
          logger.info('Market snapshot refresh skipped; a refresh ran recently.', { trigger });
          return { status: 'skipped', reason: 'recent-run' };
        }
      }

      const run = await client.query(
        `INSERT INTO market_snapshot_runs (run_trigger, status) VALUES ($1, 'running') RETURNING id`,
        [trigger],
      );
      runId = run.rows[0].id;

      const observations = await fetchMarketObservations({
        fetchImpl,
        timeoutMs: settings.requestTimeoutMs,
        feeds,
        now,
      });
      const outcomes = [];
      for (const result of observations) {
        try {
          if (!result.ok) {
            await saveFailure(client, result);
            outcomes.push({ instrument: result.instrument, ok: false, error: result.error });
          } else if (await saveSuccess(client, result)) {
            outcomes.push({ instrument: result.instrument, ok: true, dataDate: result.dataDate });
          } else {
            outcomes.push({ instrument: result.instrument, ok: false, error: 'OLDER_DATA' });
          }
        } catch (error) {
          outcomes.push({ instrument: result.instrument, ok: false, error: `DATABASE_ERROR: ${error?.code ?? 'UNKNOWN'}` });
        }
      }

      const succeeded = outcomes.filter((outcome) => outcome.ok).length;
      const status = succeeded === outcomes.length ? 'succeeded' : succeeded > 0 ? 'partial' : 'failed';
      await client.query(
        `UPDATE market_snapshot_runs SET status = $2, finished_at = NOW(), details = $3::jsonb WHERE id = $1`,
        [runId, status, JSON.stringify({ instruments: outcomes })],
      );
      await client.query(
        `DELETE FROM market_snapshot_runs WHERE started_at < NOW() - make_interval(days => $1)`,
        [RUN_RETENTION_DAYS],
      );

      const failures = outcomes.filter((outcome) => !outcome.ok);
      const log = status === 'succeeded' ? logger.info : logger.warn ?? logger.error;
      log.call(logger, 'Market snapshot refresh finished.', {
        trigger,
        status,
        updated: succeeded,
        failed: failures.map((failure) => ({ instrument: failure.instrument, error: failure.error })),
      });
      return { status, updated: succeeded, failed: failures };
    } catch (error) {
      logger.error('Market snapshot refresh failed.', { trigger, code: error?.code ?? 'UNKNOWN' });
      if (runId !== undefined) {
        await client.query(
          `UPDATE market_snapshot_runs SET status = 'failed', finished_at = NOW(), details = $2::jsonb WHERE id = $1`,
          [runId, JSON.stringify({ error: String(error?.code ?? 'UNKNOWN') })],
        ).catch(() => {});
      }
      throw error;
    } finally {
      if (locked) {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [REFRESH_LOCK_NAME]);
        } catch (error) {
          releaseError = error;
        }
      }
      // Destroy the connection if unlocking failed, which also drops the session lock.
      client.release(releaseError);
    }
  }

  async function hasSuccessfulSnapshot() {
    const { rows } = await pool.query(
      'SELECT EXISTS (SELECT 1 FROM market_snapshots WHERE fetched_at IS NOT NULL) AS present',
    );
    return rows[0]?.present === true;
  }

  // Reads stored rows only; it never contacts an external market data source.
  async function getLatestSnapshot() {
    const ids = instruments.map((instrument) => instrument.id);
    const [{ rows }, { rows: runRows }] = await Promise.all([
      pool.query('SELECT * FROM market_snapshots WHERE instrument = ANY($1::text[])', [ids]),
      pool.query(
        `SELECT run_trigger, status, started_at, finished_at
         FROM market_snapshot_runs
         WHERE status <> 'running'
         ORDER BY started_at DESC LIMIT 1`,
      ),
    ]);
    const byId = new Map(rows.map((row) => [row.instrument, row]));
    const currentTime = now().getTime();
    const staleAfterMs = settings.staleAfterHours * 60 * 60 * 1000;

    const items = instruments.map((instrument) => {
      const row = byId.get(instrument.id);
      const fetchedAt = isoOrNull(row?.fetched_at);
      const value = numberOrNull(row?.value);
      const available = value !== null && fetchedAt !== null;
      const stale = available && currentTime - Date.parse(fetchedAt) > staleAfterMs;
      return {
        id: instrument.id,
        name: instrument.displayName,
        value: available ? value : null,
        previousClose: available ? numberOrNull(row.previous_close) : null,
        change: available ? numberOrNull(row.change) : null,
        changePercent: available ? numberOrNull(row.change_percent) : null,
        unit: instrument.unit,
        currency: instrument.currency,
        dataDate: available ? dateOnly(row.data_date) : null,
        filledFrom: available ? dateOnly(row.filled_from) : null,
        sourceStatus: available ? row.source_status : null,
        source: available ? { id: row.source_id, name: row.source_name, url: row.source_url } : null,
        sourceGeneratedAt: available ? isoOrNull(row.source_generated_at) : null,
        updatedAt: fetchedAt,
        lastAttemptAt: isoOrNull(row?.last_attempt_at),
        lastAttemptStatus: row?.status ?? null,
        status: !available ? 'unavailable' : stale ? 'stale' : 'ok',
      };
    });

    const available = items.filter((item) => item.status !== 'unavailable');
    const updatedTimes = available.map((item) => Date.parse(item.updatedAt));
    const status = available.length === 0
      ? 'unavailable'
      : items.some((item) => item.status === 'stale')
        ? 'stale'
        : available.length < items.length || items.some((item) => item.lastAttemptStatus === 'error')
          ? 'partial'
          : 'ok';
    const lastRun = runRows[0];

    return {
      status,
      realtime: false,
      snapshotUpdatedAt: updatedTimes.length ? new Date(Math.max(...updatedTimes)).toISOString() : null,
      staleAfterHours: settings.staleAfterHours,
      lastRun: lastRun
        ? {
          trigger: lastRun.run_trigger,
          status: lastRun.status,
          startedAt: isoOrNull(lastRun.started_at),
          finishedAt: isoOrNull(lastRun.finished_at),
        }
        : null,
      instruments: items,
    };
  }

  return { refresh, hasSuccessfulSnapshot, getLatestSnapshot };
}
