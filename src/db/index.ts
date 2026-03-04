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
