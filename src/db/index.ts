import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) throw new Error("[DB] Not initialized — call initDb() first");
  return db;
}

export function initDb(dataDir = "data"): void {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "polymarket-bot.db");
  db = new Database(dbPath);
  // WAL mode = much faster writes, safe concurrent reads
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  runMigrations(db);
  // Reconcile stale PENDING trades from a previous crashed run.
  // FOK orders are instantaneous — any PENDING left over means the process died
  // before receiving the response, so we can't know if it filled. Reset to FAILED
  // so these will be retried (duplicate-prevention still guards against re-copy on
  // the same leader_trade_id if the order actually went through).
  const staleResult = db
    .prepare(`UPDATE copied_trades SET status='FAILED', updated_at=datetime('now') WHERE status='PENDING'`)
    .run();
  if (staleResult.changes > 0) {
    console.log(`[DB] Reconciled ${staleResult.changes} stale PENDING trade(s) → FAILED`);
  }
  console.log(`[DB] Initialized at ${dbPath}`);
}

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS copied_trades (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      leader_trade_id   TEXT    NOT NULL UNIQUE,
      leader_address    TEXT    NOT NULL,
      asset_id          TEXT    NOT NULL,
      market_id         TEXT    NOT NULL,
      side              TEXT    NOT NULL,
      size              TEXT    NOT NULL,
      price             TEXT    NOT NULL,
      amount_usd        TEXT    NOT NULL,
      transaction_hash  TEXT,
      status            TEXT    NOT NULL DEFAULT 'PENDING',
      timestamp         TEXT    NOT NULL,
      entry_price       TEXT,
      exit_price        TEXT,
      pnl               TEXT,
      pnl_pct           TEXT,
      created_at        TEXT    DEFAULT (datetime('now')),
      updated_at        TEXT    DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_leader_trade_id ON copied_trades(leader_trade_id);
    CREATE INDEX IF NOT EXISTS idx_leader_address  ON copied_trades(leader_address);
    CREATE INDEX IF NOT EXISTS idx_timestamp       ON copied_trades(timestamp);
    CREATE INDEX IF NOT EXISTS idx_status          ON copied_trades(status);
  `);
}
