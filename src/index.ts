import { loadConfig } from "./config";
import { createClient, ensureUsdcApproval } from "./config/client";
import { runActivityStream, logTrade, runPositionPolling } from "./realtime";
import { copyTrade, shouldCopyTrade, recordEntry, runExitLoop, redeemBotPosition } from "./trading";
import { startWebServer, setStatus, setUiConfig, setClient, setChainId, setBotPositionSizes, getBotPositionSizes } from "./web";
import { initDb } from "./db";
import { hasFilledBuyForAsset } from "./db/queries";
import { DATA_API } from "./constant";
import type { LeaderTrade } from "./types";

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
  if (!config.simulationMode) {
    if (!config.walletPrivateKey) {
      console.error("No wallet. Set WALLET_PRIVATE_KEY in .env");
      process.exit(1);
    }
    if (!config.proxyWalletAddress && config.signatureType !== 0) {
      console.error("Set PROXY_WALLET_ADDRESS in .env for proxy/Magic wallet");
      process.exit(1);
    }
  }

  const client = config.simulationMode ? null : await createClient(config);
  if (client) setClient(client);
  setChainId(config.chainId);

  // ── Verify USDC balance and exchange allowance, approve if needed ──────────
  if (!config.simulationMode && config.walletPrivateKey) {
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
  if (monitorOnly) console.log("[MONITOR] Monitor mode — no new copy-trade orders will be placed (manual sells still work)");

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

  // ── Shared polling callback ───────────────────────────────────────────────
  // For BUYs: run through normal filters.
  // For SELLs: if we hold a copied position for this asset, ALWAYS exit it
  //   (bypass revert_trade — that flag only prevents copying arbitrary sells
  //   of things we don't hold). Use the bot's actual held size so we sell
  //   exactly what we own, not a scaled fraction of the leader's delta.
  function executeTrade(trade: LeaderTrade, fromUser: string, multiplier: number): void {
    if (config.simulationMode) {
      logTrade("SIM", trade, { targetAddress: fromUser, copyStatus: "skipped" });
    } else if (client) {
      copyTrade(client, trade, multiplier, config.chainId, config.filter.buyAmountLimitInUsd, fromUser)
        .then((filled) => {
          if (filled == null) { logTrade("LIVE", trade, { targetAddress: fromUser, copyStatus: "skip" }); return; }
          if (trade.side === "BUY") recordEntry(trade.asset_id, filled.size, filled.price);
          logTrade("LIVE", trade, { targetAddress: fromUser, copyStatus: "ok", amountUsd: filled.amountUsd });
        })
        .catch((e) => {
          logTrade("LIVE", trade, { targetAddress: fromUser, copyStatus: "FAILED" });
          console.error("  ", e?.message ?? e);
        });
    }
  }

  function handlePolledTrade(trade: LeaderTrade, fromUser: string): void {
    if (monitorOnly) return;

    // ── REDEEM: leader exited a resolved market — mirror the on-chain redemption
    if (trade.side === "REDEEM") {
      const botSize = getBotPositionSizes().get(trade.asset_id) ?? 0;
      const weHold  = botSize > 0 && hasFilledBuyForAsset(fromUser, trade.asset_id);
      if (weHold) {
        const redeemTrade = { ...trade, size: String(botSize) };
        if (config.simulationMode) {
          logTrade("SIM", redeemTrade, { targetAddress: fromUser, copyStatus: "would redeem" });
        } else if (config.walletPrivateKey) {
          logTrade("REDEEM", redeemTrade, { targetAddress: fromUser, copyStatus: "leader redeemed" });
          redeemBotPosition(redeemTrade, config, fromUser).catch((e) =>
            console.error("[REDEEM] Auto-redeem failed:", e?.message ?? e)
          );
        }
      } else {
        logTrade("SKIP", trade, { targetAddress: fromUser, copyStatus: "REDEEM — not holding" });
      }
      return;
    }

    if (trade.side === "SELL") {
      const botSize = getBotPositionSizes().get(trade.asset_id) ?? 0;
      const weHold = botSize > 0 && hasFilledBuyForAsset(fromUser, trade.asset_id);
      if (weHold) {
        // Leader closed a position we copied → always mirror the exit.
        // Bypass shouldCopyTrade (revert_trade only blocks arbitrary short-sells,
        // not closing positions we already entered).
        // Sell the bot's exact on-chain size at multiplier 1 (no scaling).
        const exitTrade = { ...trade, size: String(botSize) };
        logTrade("EXIT", exitTrade, { targetAddress: fromUser, copyStatus: "leader exited" });
        executeTrade(exitTrade, fromUser, 1.0);
        return;
      }
      // We don't hold it — respect the revert_trade filter
      if (!config.copy.revertTrade) {
        logTrade("SKIP", trade, { targetAddress: fromUser, copyStatus: "revert_trade=false" });
        return;
      }
    }

    if (!shouldCopyTrade(config, trade)) return;
    executeTrade(trade, fromUser, config.copy.sizeMultiplier);
  }

  if (targets.length === 1) {
    console.log(monitorOnly ? "Monitor" : config.simulationMode ? "Simulation" : "Subscribe", "| 1 target");
    if (!monitorOnly) runActivityStream(client, config);
    runPositionPolling(config, handlePolledTrade);
    // runPositionsUiPoll not needed — runPositionPolling already calls setPositions
  } else {
    console.log(monitorOnly ? "Monitor" : config.simulationMode ? "Simulation" : "Polling", `| ${targets.length} targets`);
    runPositionPolling(config, handlePolledTrade);
  }
}
run().catch((e) => {
  console.error(e);
  process.exit(1);
});