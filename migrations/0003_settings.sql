-- The owner's settings, e.g. their Cloudflare API token (usage, errors and secrets of their apps).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
