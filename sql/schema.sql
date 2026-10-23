CREATE TABLE IF NOT EXISTS subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(254) NOT NULL UNIQUE CHECK (email = LOWER(email)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'unsubscribed')),
  verification_token TEXT UNIQUE,
  unsubscribe_token UUID UNIQUE,
  verified_at TIMESTAMPTZ,
  subscribed_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT subscribers_verification_state_check CHECK (
    (status = 'pending' AND verification_token IS NOT NULL AND unsubscribe_token IS NULL
      AND verified_at IS NULL AND subscribed_at IS NULL AND unsubscribed_at IS NULL)
    OR (status = 'active' AND verification_token IS NULL AND unsubscribe_token IS NOT NULL
      AND subscribed_at IS NOT NULL AND unsubscribed_at IS NULL)
    OR (status = 'unsubscribed' AND verification_token IS NULL AND unsubscribe_token IS NOT NULL
      AND unsubscribed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS subscribers_active_id_idx
  ON subscribers (id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS newsletters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (LENGTH(TRIM(title)) BETWEEN 1 AND 300),
  subject TEXT NOT NULL CHECK (LENGTH(TRIM(subject)) BETWEEN 1 AND 998),
  html_content TEXT NOT NULL CHECK (
    LENGTH(TRIM(html_content)) > 0 AND LENGTH(html_content) <= 450000
  ),
  send_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed')),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS newsletters_due_idx
  ON newsletters (send_at, id) WHERE status IN ('scheduled', 'sending');

CREATE OR REPLACE FUNCTION set_newsletters_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS newsletters_updated_at_trigger ON newsletters;
CREATE TRIGGER newsletters_updated_at_trigger
  BEFORE UPDATE ON newsletters
  FOR EACH ROW EXECUTE FUNCTION set_newsletters_updated_at();

CREATE TABLE IF NOT EXISTS newsletter_deliveries (
  newsletter_id UUID NOT NULL REFERENCES newsletters (id) ON DELETE CASCADE,
  subscriber_id UUID NOT NULL REFERENCES subscribers (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (newsletter_id, subscriber_id)
);

CREATE INDEX IF NOT EXISTS newsletter_deliveries_status_idx
  ON newsletter_deliveries (newsletter_id, status);

-- Market data snapshots shown in the article sidebar. One row per instrument keeps the
-- latest successful values; failed refreshes only update the attempt/error columns.
CREATE TABLE IF NOT EXISTS market_snapshots (
  instrument TEXT PRIMARY KEY CHECK (instrument ~ '^[A-Z0-9_.]{1,40}$'),
  display_name TEXT NOT NULL CHECK (LENGTH(TRIM(display_name)) BETWEEN 1 AND 100),
  dataset TEXT NOT NULL CHECK (LENGTH(TRIM(dataset)) BETWEEN 1 AND 40),
  value NUMERIC(20, 6),
  previous_close NUMERIC(20, 6),
  change NUMERIC(20, 6),
  change_percent NUMERIC(14, 6),
  unit TEXT,
  currency TEXT,
  source_id TEXT,
  source_name TEXT,
  source_url TEXT,
  source_status TEXT,
  data_date DATE,
  filled_from DATE,
  source_generated_at TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  last_error TEXT CHECK (last_error IS NULL OR LENGTH(last_error) <= 500),
  last_error_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  CONSTRAINT market_snapshots_value_state_check CHECK (
    (value IS NULL AND fetched_at IS NULL AND data_date IS NULL)
    OR (value IS NOT NULL AND fetched_at IS NOT NULL AND data_date IS NOT NULL AND source_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS market_snapshot_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_trigger TEXT NOT NULL CHECK (run_trigger IN ('scheduled', 'bootstrap', 'manual')),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  details JSONB
);

CREATE INDEX IF NOT EXISTS market_snapshot_runs_started_at_idx
  ON market_snapshot_runs (started_at DESC);
