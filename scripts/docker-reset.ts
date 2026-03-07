/**
 * docker-reset — stop the bot, wipe the DB volume, rebuild and restart.
 * Cross-platform: avoids shell semicolon/pipe issues in npm scripts.
 * Usage: npm run docker:reset
 */
import { execSync } from "child_process";

function run(cmd: string): void {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

function tryRun(cmd: string): void {
  console.log(`\n> ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch {
    console.log("  (ignored — continuing)");
  }
}

run("docker compose down");
tryRun("docker volume rm polymarket-copytrading-bot-sport-fork_bot-data");
tryRun("docker volume rm polymarket-copytrading-bot-sport-fork_dbgate-config");
run("docker compose up --build -d");
