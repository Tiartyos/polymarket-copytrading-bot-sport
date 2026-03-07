/**
 * reset-db — removes the SQLite database and its WAL/SHM sidecar files.
 * Run:  npm run reset-db
 * The database will be re-created (with fresh migrations) on next startup.
 */
import fs from "fs";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "polymarket-bot.db");

const targets = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`];

let removed = 0;
for (const f of targets) {
  if (fs.existsSync(f)) {
    fs.rmSync(f);
    console.log(`  removed  ${path.relative(process.cwd(), f)}`);
    removed++;
  }
}

if (removed === 0) {
  console.log("No database files found — nothing to remove.");
} else {
  console.log(`\nDatabase reset. It will be re-created on next startup.`);
}
