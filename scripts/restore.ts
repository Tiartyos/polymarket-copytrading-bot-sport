#!/usr/bin/env tsx
/**
 * Restore script — recovers DB + data from a backup folder.
 *
 * Auto-detects docker vs local mode.
 * For Docker: the bot container must exist (running or stopped).
 *             Run `docker compose up -d` first if it has never been started.
 *
 * Usage:
 *   tsx scripts/restore.ts [--latest] [--local | --docker]
 *   tsx scripts/restore.ts backup-2026-03-07T10-00-00 [--local | --docker]
 *
 * Examples:
 *   tsx scripts/restore.ts --latest
 *   tsx scripts/restore.ts backup-2026-03-07T10-00-00
 *   tsx scripts/restore.ts --latest --docker
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const BACKUP_DIR = path.resolve("backups");
const args = process.argv.slice(2);

// ── helpers ───────────────────────────────────────────────────────────────────

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
    // docker not available
  }
  return "local";
}

function resolveBackupPath(): string {
  // Positional arg (not a flag) is treated as a backup name / path
  const nameArg = args.find((a) => !a.startsWith("--"));

  if (args.includes("--latest") || !nameArg) {
    if (!fs.existsSync(BACKUP_DIR)) {
      console.error(`[restore] ERROR: No backups directory found at ${BACKUP_DIR}`);
      process.exit(1);
    }
    const entries = fs
      .readdirSync(BACKUP_DIR)
      .filter((e) => /^backup-\d{4}-/.test(e))
      .sort()
      .reverse();

    if (!entries.length) {
      console.error("[restore] ERROR: No backups found in", BACKUP_DIR);
      process.exit(1);
    }

    const chosen = path.join(BACKUP_DIR, entries[0]);
    console.log(`[restore] Using latest backup: ${entries[0]}`);
    return chosen;
  }

  // Absolute path or relative to BACKUP_DIR
  return path.isAbsolute(nameArg) ? nameArg : path.join(BACKUP_DIR, nameArg);
}

// ── restore strategies ────────────────────────────────────────────────────────

function restoreLocal(backupPath: string) {
  const backupData = path.join(backupPath, "data");
  if (!fs.existsSync(backupData)) {
    console.error(`[restore] ERROR: backup data dir not found: ${backupData}`);
    process.exit(1);
  }

  const dataDir = path.resolve("data");

  // Rename existing data/ so it can be recovered if something goes wrong
  if (fs.existsSync(dataDir)) {
    const safeName = `${dataDir}-pre-restore-${Date.now()}`;
    fs.renameSync(dataDir, safeName);
    console.log(`[restore] Moved existing data/ → ${path.basename(safeName)}`);
  }

  fs.cpSync(backupData, dataDir, { recursive: true });
  console.log(`[restore] Copied ${backupData} → ${dataDir}`);
}

function restoreDocker(backupPath: string) {
  const backupData = path.join(backupPath, "data");
  if (!fs.existsSync(backupData)) {
    console.error(`[restore] ERROR: backup data dir not found: ${backupData}`);
    process.exit(1);
  }

  // Trailing /. copies directory contents without creating extra nesting
  execSync(`docker compose cp "${backupData}/." bot:/app/data/`, { stdio: "inherit" });
  console.log(`[restore] Copied ${backupData} → bot:/app/data/`);
}

// ── main ──────────────────────────────────────────────────────────────────────

function main() {
  const mode = detectMode();
  const backupPath = resolveBackupPath();

  if (!fs.existsSync(backupPath)) {
    console.error(`[restore] ERROR: backup not found: ${backupPath}`);
    process.exit(1);
  }

  const meta = path.join(backupPath, "meta.json");
  if (fs.existsSync(meta)) {
    const { createdAt, mode: backupMode } = JSON.parse(fs.readFileSync(meta, "utf-8"));
    console.log(`[restore] Backup created: ${createdAt} | Backup mode: ${backupMode}`);
  }

  console.log(`[restore] Restoring in ${mode} mode from: ${path.basename(backupPath)}`);

  if (mode === "docker") {
    console.log("[restore] NOTE: bot container must exist. If fresh install run `docker compose up -d` first.");
    restoreDocker(backupPath);
  } else {
    restoreLocal(backupPath);
  }

  console.log("[restore] ✓ Restore complete");

  if (mode === "docker") {
    console.log("[restore] Restart the container to apply: docker compose restart bot");
  }
}

main();
