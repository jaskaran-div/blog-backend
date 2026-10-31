// Trimmed copies of SnapData responses captured on 2026-10-23.
export function ratesPayload(overrides = {}) {
  return {
    schema_version: '1.0',
    generated_at: '2026-10-20T21:30:00Z',
    dataset: 'rates',
    scope: 'world',
    resolution: 'daily',
    unit: { quantity: 'percent', currency: 'USD' },
    sources: [{ id: 'treasury', name: 'US Department of the Treasury', url: 'https://home.treasury.gov/' }],
    observations: [
      { date: '2026-10-20', instrument: 'UST10Y', value: 5.12, prev_close: 5.15, change_pct: -0.5825, status: 'provisional', filled_from: null, source: 'treasury' },
      { date: '2026-10-20', instrument: 'UST2Y', value: 4.79, prev_close: 4.77, change_pct: 0.4193, status: 'provisional', filled_from: null, source: 'treasury' },
    ],
    ...overrides,
  };
}

export function crudePayload(overrides = {}) {
  return {
    schema_version: '1.0',
    generated_at: '2026-10-16T21:30:00Z',
    dataset: 'crude',
    scope: 'world',
    resolution: 'daily',
    unit: { quantity: 'barrel', currency: 'USD' },
    sources: [{ id: 'eia', name: 'US Energy Information Administration', url: 'https://www.eia.gov/opendata/' }],
    observations: [
      { date: '2026-10-14', instrument: 'BRENT', value: 126.55, prev_close: 125.78, change_pct: 0.6122, status: 'final', filled_from: null, source: 'eia' },
      { date: '2026-10-14', instrument: 'WTI', value: 101.91, prev_close: 100.86, change_pct: 1.041, status: 'final', filled_from: null, source: 'eia' },
    ],
    ...overrides,
  };
}

// FX has no envelope unit; values are ECB reference rates cross-rated to USD pairs.
export function fxPayload(overrides = {}) {
  return {
    schema_version: '1.0',
    generated_at: '2026-10-30T15:30:00Z',
    dataset: 'fx',
    scope: 'world',
    resolution: 'daily',
    unit: null,
    sources: [{ id: 'ecb', name: 'European Central Bank reference rates', url: 'https://www.ecb.europa.eu/stats/eurofxref/' }],
    observations: [
      { date: '2026-10-30', instrument: 'EURUSD', value: 1.1172, prev_close: 1.113, change_pct: 0.3774, status: 'provisional', filled_from: null, source: 'ecb' },
      { date: '2026-10-30', instrument: 'GBPUSD', value: 1.3399, prev_close: 1.3317, change_pct: 0.6158, status: 'provisional', filled_from: null, source: 'ecb' },
      { date: '2026-10-30', instrument: 'USDINR', value: 94.9552, prev_close: 95.2691, change_pct: -0.3295, status: 'provisional', filled_from: null, source: 'ecb' },
      { date: '2026-10-30', instrument: 'USDJPY', value: 157.2503, prev_close: 158.0593, change_pct: -0.5118, status: 'provisional', filled_from: null, source: 'ecb' },
    ],
    ...overrides,
  };
}

export function jsonResponse(body, { status = 200, contentType = 'application/json; charset=utf-8' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

export function snapDataFetch(handlers) {
  const calls = [];
  async function fetchImpl(url, options) {
    calls.push(url);
    const key = Object.keys(handlers).find((fragment) => url.includes(fragment));
    if (!key) {
      throw new Error(`Unexpected URL ${url}`);
    }
    return handlers[key](options);
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}
