import { loadConfig } from "./config";
import { createClient, ensureUsdcApproval } from "./config/client";
import { runActivityStream, logTrade, runPositionPolling, runPositionsUiPoll } from "./realtime";
import { copyTrade, shouldCopyTrade, recordEntry, runExitLoop } from "./trading";
import { startWebServer, setStatus, setUiConfig, setClient, setBotPositionSizes } from "./web";
import { initDb } from "./db";
import { DATA_API } from "./constant";

async function run() {
  const monitorOnly = process.argv.includes("--monitor");
  const config = loadConfig();

  // Initialize persistence layer — must happen before any trade logic
  initDb("data");

  const targets = config.copy.targetAddresses;
  if (!targets.length) {
    console.error("No targets. Set copy.target_address in trade.toml");
    process.exit(1);
  }
  if (!config.simulationMode && !monitorOnly) {
    if (!config.walletPrivateKey) {
      console.error("No wallet. Set WALLET_PRIVATE_KEY in .env");
      process.exit(1);
    }
    if (!config.proxyWalletAddress && config.signatureType !== 0) {
      console.error("Set PROXY_WALLET_ADDRESS in .env for proxy/Magic wallet");
      process.exit(1);
    }
  }

  const client = (config.simulationMode || monitorOnly) ? null : await createClient(config);
  if (client) setClient(client);

  // ── Verify USDC balance and exchange allowance, approve if needed ──────────
  if (!config.simulationMode && !monitorOnly && config.walletPrivateKey) {
    await ensureUsdcApproval(config.walletPrivateKey, config.chainId).catch((e) =>
      console.error("[USDC] Allowance check failed:", e?.message ?? e)
    );
  }

  if (!monitorOnly && client && (config.exit.takeProfit > 0 || config.exit.stopLoss > 0 || config.exit.trailingStop > 0)) {
    runExitLoop(client, config);
  }

  setStatus(monitorOnly ? "Monitor" : config.simulationMode ? "Sim" : "Live", targets.length, config.walletAddress, targets);
  if (config.ui) setUiConfig(config.ui);
  startWebServer(config.port);
  if (monitorOnly) console.log("[MONITOR] Read-only mode — no orders will be placed");

  // ── Poll bot wallet's live positions so UI knows which fills are still open ──
  if (!config.simulationMode && config.walletAddress) {
    const botAddr = config.walletAddress.toLowerCase();
    const pollBotPositions = async () => {
      try {
        const res = await fetch(`${DATA_API}/positions?user=${encodeURIComponent(botAddr)}&limit=500`);
        if (!res.ok) return;
        const data = (await res.json()) as { asset: string; size: number }[];
        setBotPositionSizes(data.map((p) => ({ asset: p.asset, size: p.size })));
      } catch { /* ignore */ }
    };
    pollBotPositions();
    setInterval(pollBotPositions, 30_000);
  }

  if (targets.length === 1) {
    console.log(monitorOnly ? "Monitor" : config.simulationMode ? "Simulation" : "Subscribe", "| 1 target");
    if (!monitorOnly) runActivityStream(client, config);
    runPositionsUiPoll(config);
  } else {
    console.log(monitorOnly ? "Monitor" : config.simulationMode ? "Simulation" : "Polling", `| ${targets.length} targets`);
    runPositionPolling(config, (trade, fromUser) => {
      if (monitorOnly) return;
      if (!shouldCopyTrade(config, trade)) return;
      if (config.simulationMode) {
        logTrade("SIM", trade, { targetAddress: fromUser, copyStatus: "skipped" });
      } else if (client) {
        copyTrade(
          client,
          trade,
          config.copy.sizeMultiplier,
          config.chainId,
          config.filter.buyAmountLimitInUsd,
          fromUser
        )
          .then((filled) => {
            if (filled == null) {
              logTrade("LIVE", trade, { targetAddress: fromUser, copyStatus: "skip" });
              return;
            }
            if (trade.side === "BUY") recordEntry(trade.asset_id, filled.size, filled.price);
            logTrade("LIVE", trade, { targetAddress: fromUser, copyStatus: "ok", amountUsd: filled.amountUsd });
          })
          .catch((e) => {
            logTrade("LIVE", trade, { targetAddress: fromUser, copyStatus: "FAILED" });
            console.error("  ", e?.message ?? e);
          });
      }
    });
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
