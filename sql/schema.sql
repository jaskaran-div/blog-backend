CREATE TABLE IF NOT EXISTS subscribers (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  email VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  verification_token VARCHAR(128) NULL,
  unsubscribe_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  verified_at DATETIME(3) NULL,
  subscribed_at DATETIME(3) NULL,
  unsubscribed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY subscribers_email_unique (email),
  UNIQUE KEY subscribers_verification_token_unique (verification_token),
  UNIQUE KEY subscribers_unsubscribe_token_unique (unsubscribe_token),
  KEY subscribers_active_id_idx (status, id),
  CONSTRAINT subscribers_status_check
    CHECK (status IN ('pending', 'active', 'unsubscribed')),
  CONSTRAINT subscribers_email_lowercase_check
    CHECK (email = LOWER(email)),
  CONSTRAINT subscribers_verification_state_check CHECK (
    (status = 'pending' AND verification_token IS NOT NULL AND unsubscribe_token IS NULL
      AND verified_at IS NULL AND subscribed_at IS NULL AND unsubscribed_at IS NULL)
    OR (status = 'active' AND verification_token IS NULL AND unsubscribe_token IS NOT NULL
      AND subscribed_at IS NOT NULL AND unsubscribed_at IS NULL)
    OR (status = 'unsubscribed' AND verification_token IS NULL AND unsubscribe_token IS NOT NULL
      AND unsubscribed_at IS NOT NULL)
  )
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS newsletters (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(300) NOT NULL,
  subject VARCHAR(998) NOT NULL,
  html_content LONGTEXT NOT NULL,
  send_at DATETIME(3) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  sent_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY newsletters_due_idx (status, send_at, id),
  CONSTRAINT newsletters_status_check
    CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed')),
  CONSTRAINT newsletters_title_check
    CHECK (CHAR_LENGTH(TRIM(title)) BETWEEN 1 AND 300),
  CONSTRAINT newsletters_subject_check
    CHECK (CHAR_LENGTH(TRIM(subject)) BETWEEN 1 AND 998),
  CONSTRAINT newsletters_html_content_check
    CHECK (CHAR_LENGTH(TRIM(html_content)) > 0 AND CHAR_LENGTH(html_content) <= 450000)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS newsletter_deliveries (
  newsletter_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subscriber_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  sent_at DATETIME(3) NULL,
  last_error VARCHAR(1000) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (newsletter_id, subscriber_id),
  KEY newsletter_deliveries_status_idx (newsletter_id, status),
  CONSTRAINT newsletter_deliveries_newsletter_fk
    FOREIGN KEY (newsletter_id) REFERENCES newsletters (id) ON DELETE CASCADE,
  CONSTRAINT newsletter_deliveries_subscriber_fk
    FOREIGN KEY (subscriber_id) REFERENCES subscribers (id) ON DELETE CASCADE,
  CONSTRAINT newsletter_deliveries_status_check
    CHECK (status IN ('sending', 'sent', 'failed')),
  CONSTRAINT newsletter_deliveries_attempts_check CHECK (attempts >= 0)
) ENGINE=InnoDB;
