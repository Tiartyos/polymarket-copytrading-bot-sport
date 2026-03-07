#!/usr/bin/env tsx
/**
 * Backup script — copies DB + data to ./backups/backup-<timestamp>/
 *
 * Auto-detects docker vs local mode. Prunes oldest backups beyond MAX_BACKUPS.
 *
 * Usage:
 *   tsx scripts/backup.ts [--local | --docker] [--max-backups <N>]
 *
 * Env vars:
 *   MAX_BACKUPS  — max rolling backups to keep (default: 12)
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const BACKUP_DIR = path.resolve("backups");
const args = process.argv.slice(2);

const maxBackups = (() => {
  const idx = args.indexOf("--max-backups");
  return idx !== -1 ? Number(args[idx + 1]) : Number(process.env.MAX_BACKUPS ?? 12);
})();

// ── helpers ──────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function detectMode(): "docker" | "local" {
  if (args.includes("--local")) return "local";
  if (args.includes("--docker")) return "docker";
  try {
    const out = execSync("docker compose ps -q", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (out.trim()) return "docker";
  } catch {
    // docker not available or no compose project
  }
  return "local";
}

// ── rolling prune ─────────────────────────────────────────────────────────────

function pruneOldBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const entries = fs
    .readdirSync(BACKUP_DIR)
    .filter((e) => /^backup-\d{4}-/.test(e))
    .map((e) => ({ name: e, time: fs.statSync(path.join(BACKUP_DIR, e)).mtimeMs }))
    .sort((a, b) => a.time - b.time);

  // Keep < maxBackups so after creating the new one we land exactly at maxBackups
  while (entries.length >= maxBackups) {
    const oldest = entries.shift()!;
    fs.rmSync(path.join(BACKUP_DIR, oldest.name), { recursive: true, force: true });
    console.log(`[backup] Pruned old backup: ${oldest.name}`);
  }
}

// ── backup strategies ─────────────────────────────────────────────────────────

function backupLocal(dest: string) {
  const src = path.resolve("data");
  if (!fs.existsSync(src)) {
    console.error(`[backup] ERROR: data dir not found at ${src}`);
    process.exit(1);
  }
  fs.cpSync(src, path.join(dest, "data"), { recursive: true });
  console.log(`[backup] Copied ${src} → ${dest}/data`);
}

function backupDocker(dest: string) {
  const dataPath = path.join(dest, "data");
  ensureDir(dataPath);
  // docker compose cp copies from the running/stopped container's filesystem.
  // Trailing /. copies contents without creating an extra nesting level.
  execSync(`docker compose cp bot:/app/data/. "${dataPath}"`, { stdio: "inherit" });
  console.log(`[backup] Docker data copied → ${dataPath}`);
}

// ── main ──────────────────────────────────────────────────────────────────────

function main() {
  const mode = detectMode();
  console.log(`[backup] Mode: ${mode} | Max backups kept: ${maxBackups}`);

  ensureDir(BACKUP_DIR);
  pruneOldBackups();

  const dest = path.join(BACKUP_DIR, `backup-${ts()}`);
  ensureDir(dest);
  console.log(`[backup] Destination: ${dest}`);

  if (mode === "docker") {
    backupDocker(dest);
  } else {
    backupLocal(dest);
  }

  fs.writeFileSync(
    path.join(dest, "meta.json"),
    JSON.stringify({ createdAt: new Date().toISOString(), mode, maxBackups }, null, 2),
  );

  console.log("[backup] ✓ Backup complete");
}

main();
