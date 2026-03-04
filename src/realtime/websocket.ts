import { RealTimeDataClient } from "@polymarket/real-time-data-client";
import type { AppConfig, ActivityTradePayload } from "../types";
import { copyTrade, activityPayloadToLeaderTrade } from "../trading";
import { shouldCopyTrade } from "../trading/filter";
import { recordEntry } from "../trading/exit";
import { pushTrade } from "../web/state";
import type { ClobClient } from "@polymarket/clob-client";
import { MAX_SEEN } from "../constant";


function fmtTime(): string {
  return new Date().toISOString();
}

export function logTrade(
  tag: string,
  trade: { side: string; size: string; price: string; asset_id: string; slug?: string; outcome?: string },
  opts?: string | { targetAddress?: string; copyStatus?: string; amountUsd?: number }
): void {
  const slug = trade.slug ?? trade.asset_id.slice(0, 12) + "\u2026";
  const outcome = trade.outcome ?? "?";
  const amountUsd = typeof opts === "object" && opts?.amountUsd != null
    ? ` [$${opts.amountUsd.toFixed(2)}]`
    : "";
  const line = [fmtTime(), tag, trade.side, outcome, `size ${trade.size} @ ${trade.price}${amountUsd}`, slug].join(" | ");
  const extra =
    typeof opts === "string"
      ? opts
      : opts
        ? [opts.targetAddress ? `from ${opts.targetAddress}` : "", opts.copyStatus ?? ""].filter(Boolean).join(" ")
        : "";
  console.log(extra ? `${line} | ${extra}` : line);
  pushTrade(tag, trade, opts);
}

function pruneSeen(seen: Set<string>): void {
  if (seen.size <= MAX_SEEN) return;
  const arr = [...seen].slice(-MAX_SEEN / 2);
  seen.clear();
  arr.forEach((id) => seen.add(id));
}

export function runActivityStream(client: ClobClient | null, config: AppConfig): void {
  const target = config.copy.targetAddress.toLowerCase();
  const seen = new Set<string>();

  const rt = new RealTimeDataClient({
    autoReconnect: true,
    onConnect(rtClient) {
      console.log(`${fmtTime()} | stream connected, watching ${target}`);
      rtClient.subscribe({
        subscriptions: [{
          topic: "activity",
          type: "trades",
          // Filter events to the specific target wallet; without this the server
          // delivers nothing for third-party wallets.
          gamma_auth: { address: target },
        }],
      });

      // The library's built-in ping cycle is broken (assigns ws.pong as a
      // property instead of registering an event listener, so onPong never
      // fires). Roll our own keepalive so the server doesn't close with 1006.
      const ws = (rtClient as unknown as { ws: { readyState: number; send: (d: string) => void } }).ws;
      const keepalive = setInterval(() => {
        if (ws.readyState === 1 /* OPEN */) {
          ws.send("ping");
        } else {
          clearInterval(keepalive);
        }
      }, 30_000);
    },
    onMessage(_, message) {
      if (message.topic !== "activity" || message.type !== "trades") return;
      const p = message.payload as Record<string, unknown>;
      const proxy = (p.proxyWallet as string)?.toLowerCase();
      if (!proxy || proxy !== target) return;
      const trade = activityPayloadToLeaderTrade(p as ActivityTradePayload);
      if (!trade) return;
      if (seen.has(trade.id)) return;
      seen.add(trade.id);
      pruneSeen(seen);
      if (!shouldCopyTrade(config, trade)) return;
      if (config.simulationMode) {
        logTrade("SIM", trade, { copyStatus: "skipped" });
      } else if (client) {
        copyTrade(
          client,
          trade,
          config.copy.sizeMultiplier,
          config.chainId,
          config.filter.buyAmountLimitInUsd,
          config.copy.targetAddress
        )
          .then((filled) => {
            if (filled == null) {
              logTrade("LIVE", trade, { targetAddress: config.copy.targetAddress, copyStatus: "skip" });
              return;
            }
            if (trade.side === "BUY") recordEntry(trade.asset_id, filled.size, filled.price);
            logTrade("LIVE", trade, { targetAddress: config.copy.targetAddress, copyStatus: "ok", amountUsd: filled.amountUsd });
          })
          .catch((e) => {
            logTrade("LIVE", trade, { targetAddress: config.copy.targetAddress, copyStatus: "FAILED" });
            console.error("  ", e?.message ?? e);
          });
      }
    },
  });
  rt.connect();
}
