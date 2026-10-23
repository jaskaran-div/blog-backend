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

export function goldInPayload(overrides = {}) {
  return {
    schema_version: '1.0',
    generated_at: '2026-10-19T06:30:00Z',
    dataset: 'gold',
    scope: 'in',
    resolution: 'daily',
    unit: { quantity: 'gram', currency: 'INR' },
    sources: [{ id: 'ibja', name: 'India Bullion and Jewellers Association (IBJA)', url: 'https://ibja.co/' }],
    observations: [
      { date: '2026-10-19', instrument: 'XAU.22K', value: 13570, prev_close: 13535, change_pct: 0.2586, status: 'provisional', filled_from: null, source: 'ibja' },
      { date: '2026-10-19', instrument: 'XAU.24K', value: 14804, prev_close: 14766, change_pct: 0.2573, status: 'provisional', filled_from: null, source: 'ibja' },
    ],
    ...overrides,
  };
}

// The world gold feed is a monthly, gap-filled World Bank average.
export function goldWorldMonthlyPayload() {
  return {
    schema_version: '1.0',
    generated_at: '2026-10-20T18:30:00Z',
    dataset: 'gold',
    scope: 'world',
    resolution: 'monthly',
    unit: { quantity: 'troy_ounce', currency: 'USD' },
    sources: [{ id: 'worldbank', name: 'World Bank Commodity Price Data (Pink Sheet)' }],
    observations: [
      { date: '2026-10-21', instrument: 'XAU.SPOT', value: 4319, prev_close: null, change_pct: null, status: 'estimated', filled_from: '2026-09-01', source: 'worldbank' },
    ],
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
