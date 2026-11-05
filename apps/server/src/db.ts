import { DatabaseSync } from 'node:sqlite'

export type Row = Record<string, any>

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  try {
    return setUp(db)
  } catch (e) {
    db.close() // a failed start must not leave the database file locked
    throw e
  }
}

function setUp(db: DatabaseSync): DatabaseSync {
  const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all() as Row[]
  if (cols.length > 0 && !cols.some((c) => c.name === 'email')) {
    throw new Error('Database predates email/password login. It only held dev data: delete it and re-run the seed.')
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      handle TEXT NOT NULL UNIQUE,
      -- The ID in lower case. Uniqueness is enforced on this (see the index below), so "Alice" and "alice" cannot both exist.
      handle_lc TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      delay_sec INTEGER NOT NULL DEFAULT 300,
      holdings_visibility TEXT NOT NULL DEFAULT 'public',
      last_sync_ms INTEGER,
      created_ms INTEGER NOT NULL,
      avatar_ms INTEGER,
      bio TEXT NOT NULL DEFAULT ''
    );

    -- Account names only, never URLs: the address is rebuilt from a fixed template when shown.
    CREATE TABLE IF NOT EXISTS social_links (
      user_id INTEGER NOT NULL REFERENCES users(id),
      platform TEXT NOT NULL,
      handle TEXT NOT NULL,
      PRIMARY KEY (user_id, platform)
    );

    -- Profile photo, already shrunk and re-encoded by the browser (so EXIF and GPS tags are gone).
    CREATE TABLE IF NOT EXISTS avatars (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      mime TEXT NOT NULL,
      data BLOB NOT NULL
    );

    -- Browser sessions. Only a hash of the cookie value is stored.
    CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_ms INTEGER NOT NULL,
      expires_ms INTEGER NOT NULL
    );

    -- Credentials for the sync agent. Can upload data and nothing else; revocable.
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      key_hash TEXT NOT NULL UNIQUE,
      created_ms INTEGER NOT NULL,
      last_used_ms INTEGER,
      revoked_ms INTEGER
    );

    -- One broker account per user, and one user per broker account.
    CREATE TABLE IF NOT EXISTS accounts (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      broker TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      bound_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      broker_trade_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      qty INTEGER NOT NULL,
      price REAL NOT NULL,
      fee REAL NOT NULL DEFAULT 0,
      executed_ms INTEGER NOT NULL,
      executed_at TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL,
      -- 'api': pulled from the broker by the sync agent (hash-chained, counts toward rankings).
      -- 'csv': uploaded by the user (unverified, display only, outside the chain).
      source TEXT NOT NULL DEFAULT 'api',
      UNIQUE (user_id, broker_trade_id)
    );
    CREATE INDEX IF NOT EXISTS trades_user_time ON trades (user_id, executed_ms);

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      taken_ms INTEGER NOT NULL,
      taken_at TEXT NOT NULL,
      cash REAL NOT NULL,
      equity REAL NOT NULL,
      flow REAL NOT NULL,
      positions TEXT NOT NULL,
      reconciled INTEGER NOT NULL,
      mismatches TEXT NOT NULL DEFAULT '[]',
      UNIQUE (user_id, taken_ms)
    );

    -- Silent periods that overlapped a trading session. The trader could have acted unseen.
    CREATE TABLE IF NOT EXISTS gaps (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      from_ms INTEGER NOT NULL,
      to_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_ms INTEGER NOT NULL,
      deleted_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES posts(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_ms INTEGER NOT NULL,
      deleted_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS comments_post ON comments (post_id, id);

    -- One report per user per item. Enough distinct reports hide the item until a human reviews it.
    CREATE TABLE IF NOT EXISTS reports (
      reporter_id INTEGER NOT NULL REFERENCES users(id),
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_ms INTEGER NOT NULL,
      PRIMARY KEY (reporter_id, target_type, target_id)
    );

    -- A user-uploaded holdings snapshot (期初庫存). Unverified: Level 1. Lines are JSON.
    CREATE TABLE IF NOT EXISTS csv_snapshots (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      as_of TEXT NOT NULL,
      taken_ms INTEGER NOT NULL,
      taken_at TEXT NOT NULL,
      lines TEXT NOT NULL,
      mismatches TEXT NOT NULL DEFAULT '[]',
      created_ms INTEGER NOT NULL,
      UNIQUE (user_id, taken_ms)
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      user_id INTEGER NOT NULL REFERENCES users(id),
      code TEXT NOT NULL,
      added_ms INTEGER NOT NULL,
      PRIMARY KEY (user_id, code)
    );

    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL REFERENCES users(id),
      followee_id INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY (follower_id, followee_id)
    );

    -- Weekly archive of the TDCC 集保戶股權分散表, kept so changes in big-holder counts can be shown.
    CREATE TABLE IF NOT EXISTS holder_weeks (
      code TEXT NOT NULL,
      as_of TEXT NOT NULL,
      level INTEGER NOT NULL,
      people INTEGER NOT NULL,
      shares INTEGER NOT NULL,
      pct REAL NOT NULL,
      PRIMARY KEY (code, as_of, level)
    );

    -- Cash dividends from the TWSE ex-dividend list. Used to tell dividend income apart from deposits.
    CREATE TABLE IF NOT EXISTS dividend_events (
      symbol TEXT NOT NULL,
      ex_date TEXT NOT NULL,
      cash_per_share REAL NOT NULL,
      PRIMARY KEY (symbol, ex_date)
    );

    -- Stock dividends (配股) from the same list. Recorded only; see the leaderboard reason stock_dividend_unverified.
    CREATE TABLE IF NOT EXISTS stock_dividend_events (
      symbol TEXT NOT NULL,
      ex_date TEXT NOT NULL,
      ratio REAL NOT NULL,
      PRIMARY KEY (symbol, ex_date)
    );

    -- Where each user last looked at their notifications. Notifications are trades of followed traders
    -- that are already past the trader's display delay, so nothing here is ahead of the delay.
    CREATE TABLE IF NOT EXISTS notification_seen (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      seen_ms INTEGER NOT NULL
    );
    -- A block hides each side from the other: posts, comments, trades, holdings, follows and search.
    CREATE TABLE IF NOT EXISTS blocks (
      blocker_id INTEGER NOT NULL REFERENCES users(id),
      blocked_id INTEGER NOT NULL REFERENCES users(id),
      created_ms INTEGER NOT NULL,
      PRIMARY KEY (blocker_id, blocked_id)
    );
    CREATE INDEX IF NOT EXISTS blocks_blocked ON blocks (blocked_id);
  `)
  const userCols = db.prepare("SELECT name FROM pragma_table_info('users')").all() as Row[]
  if (!userCols.some((c) => c.name === 'avatar_ms')) db.exec('ALTER TABLE users ADD COLUMN avatar_ms INTEGER')
  if (!userCols.some((c) => c.name === 'bio')) db.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''")

  // Case-insensitive unique IDs. Older databases get the column added and filled in, and if two
  // existing accounts differ only by case we stop and say so rather than guess which one keeps the ID.
  if (!userCols.some((c) => c.name === 'handle_lc')) db.exec('ALTER TABLE users ADD COLUMN handle_lc TEXT')
  db.exec('UPDATE users SET handle_lc = lower(handle) WHERE handle_lc IS NULL')
  const clashes = db.prepare('SELECT handle_lc, COUNT(*) AS n FROM users GROUP BY handle_lc HAVING n > 1').all() as Row[]
  if (clashes.length > 0) {
    throw new Error(
      `Cannot enforce unique IDs: these exist in more than one capitalisation: ${clashes.map((c) => c.handle_lc).join(', ')}. ` +
        'Rename or delete the duplicates, then start again.',
    )
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_handle_lc ON users (handle_lc)')
  const tradeCols = db.prepare("SELECT name FROM pragma_table_info('trades')").all() as Row[]
  if (!tradeCols.some((c) => c.name === 'source')) {
    db.exec("ALTER TABLE trades ADD COLUMN source TEXT NOT NULL DEFAULT 'api'")
  }
  return db
}
