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
