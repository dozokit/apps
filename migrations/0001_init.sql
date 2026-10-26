-- The GitHub App the owner created in their own account (manifest flow): its key stays here.
CREATE TABLE github_app (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  app_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  pem TEXT NOT NULL,
  webhook_secret TEXT,
  html_url TEXT NOT NULL,
  installation_id INTEGER,
  created_at INTEGER NOT NULL
);

-- One-use values that tie GitHub's redirect back to the owner who started Connect GitHub.
CREATE TABLE github_states (
  state TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- The owner's apps: each one a repo made from dozokit/app-template, with its own Worker.
CREATE TABLE apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL UNIQUE,
  worker TEXT NOT NULL,
  preview_url TEXT,
  live_url TEXT,
  created_at INTEGER NOT NULL
);

-- Chat apps (Claude) connected with OAuth. Only hashes of codes and tokens are kept.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used INTEGER
);
CREATE TABLE oauth_codes (
  hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE oauth_tokens (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
