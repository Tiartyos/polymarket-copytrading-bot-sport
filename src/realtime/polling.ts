import { DATA_API } from "../constant";
import { AppConfig, LeaderTrade } from "../types";
import { setPositions } from "../web/state";
import { hasFilledBuyForAsset } from "../db/queries";

interface Position {
  asset: string;
  conditionId: string;
  size: number;
  curPrice: number;
  slug?: string;
  outcome?: string;
  endDate?: string;
}

function isExpired(endDate?: string): boolean {
  if (!endDate) return false;
  const t = new Date(endDate).getTime();
  return !isNaN(t) && t < Date.now();
}

interface PositionSnapshot {
  [asset: string]: {
    size: number;
    curPrice: number;
    slug?: string;
    outcome?: string;
    conditionId: string;
    endDate?: string;
  };
}

export function fmtTime(): string {
  return new Date().toISOString();
}

function logPositionsAll(user: string, curr: PositionSnapshot): void {
  const prefix = `${fmtTime()} | INIT | ${user}`;
  const entries = Object.entries(curr).map(
    ([asset, c]) => `  ${c.slug ?? asset.slice(0, 12) + "…"} ${c.outcome ?? "?"} size ${Number(c.size).toFixed(2)} @ ${c.curPrice}`
  );
  console.log(entries.length ? `${prefix}\n${entries.join("\n")}` : `${prefix} | (none)`);
}

function logPositionChanges(user: string, curr: PositionSnapshot, prev: PositionSnapshot): void {
  const prefix = `${fmtTime()} | POS | ${user}`;
  const lines: string[] = [];
  for (const [asset, c] of Object.entries(curr)) {
    const p = prev[asset];
    const prevSize = p?.size ?? 0;
    const delta = c.size - prevSize;
    if (delta !== 0) {
      const sign = delta > 0 ? "+" : "";
      const slug = c.slug ?? asset.slice(0, 12) + "…";
      const outcome = c.outcome ?? "?";
      lines.push(`  ${slug} ${outcome} ${sign}${Number(delta).toFixed(2)} size ${c.size} @ ${c.curPrice}`);
    }
  }
  for (const asset of Object.keys(prev)) {
    if (!(asset in curr)) {
      const p = prev[asset];
      const slug = p?.slug ?? asset.slice(0, 12) + "…";
      const outcome = p?.outcome ?? "?";
      lines.push(`  ${slug} ${outcome} -${Number(p.size).toFixed(2)} size 0 @ ${p.curPrice}`);
    }
  }
  console.log(lines.length ? `${prefix}\n${lines.join("\n")}` : `${prefix} | (no changes)`);
}

const POSITIONS_PAGE_SIZE = 500;
const POSITIONS_MAX_OFFSET = 10_000;

async function fetchPositions(user: string): Promise<Position[]> {
  const all: Position[] = [];
  let offset = 0;
  while (offset <= POSITIONS_MAX_OFFSET) {
    const url = `${DATA_API}/positions?user=${encodeURIComponent(user)}&limit=${POSITIONS_PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`positions ${res.status}`);
    const page = (await res.json()) as Position[];

    // Only hard-filter by size and expiry. curPrice-based gates ("price > 0",
    // "price != 1") caused live positions to vanish from the snapshot when the
    // data-API returned null/0 for freshly-opened markets, making those bets
    // invisible to the delta-comparison that drives copy signals.
    const valid = page.filter(
      (p) => p.asset && p.size > 0 && !isExpired(p.endDate)
    );
    all.push(...valid);
    if (page.length < POSITIONS_PAGE_SIZE) break;
    offset += POSITIONS_PAGE_SIZE;
  }
  return all;
}

export function runPositionPolling(
  config: AppConfig,
  onTrade: (trade: LeaderTrade, fromUser: string) => void
): void {
  const targets = config.copy.targetAddresses.map((a) => a.toLowerCase());
  const prev: Record<string, PositionSnapshot> = {};
  const intervalMs = Math.max(5000, config.copy.pollIntervalSec * 1000);

  async function poll() {
    for (const user of targets) {
      try {
        const positions = await fetchPositions(user);
        const curr: PositionSnapshot = {};
        for (const p of positions) {
          curr[p.asset] = {
            size: p.size,
            curPrice: p.curPrice,
            slug: p.slug,
            outcome: p.outcome,
            conditionId: p.conditionId,
            endDate: p.endDate,
          };
        }

        const pprev = prev[user];
        const posList = Object.entries(curr).map(([asset, c]) => ({ asset_id: asset, ...c }));
        setPositions(user, posList);
        if (!pprev) {
          prev[user] = curr;
          logPositionsAll(user, curr);
          continue;
        }
        logPositionChanges(user, curr, pprev);
        // Tracks brand-new assets (not previously in pprev) whose price is
        // currently invalid. These are excluded from nextPrev so they remain
        // "unseen" and will be re-evaluated on the next poll once the data API
        // has caught up with the correct price.
        const invalidNewAssets = new Set<string>();
        for (const [asset, c] of Object.entries(curr)) {
          const s = pprev[asset]?.size ?? 0;
          const delta = c.size - s;
          if (delta > 0) {
            // Skip if we already hold a filled buy for this asset AND revert_trade
            // is false (meaning we never mirrored the leader's sell that dropped
            // the position, so we still hold our copy). This prevents re-buying
            // after a leader sell+rebuy cycle when we haven't sold our position.
            if (!config.copy.revertTrade && hasFilledBuyForAsset(user, asset)) {
              console.log(`${fmtTime()} | SKIP | ${user} | ${c.slug ?? asset.slice(0, 12)} already held, revert_trade=false`);
              continue;
            }
            // Guard: a BUY with price ≤ 0 or ≥ 1 is untradeable (market
            // resolved or data-API hasn't indexed the price yet). For a
            // genuinely-new position we defer it so it's not silently added
            // to prev at this phantom state — the next poll will re-detect it
            // once the price is valid. For an existing position that just
            // increased we simply skip this cycle without corrupting prev.
            const hasValidPrice = c.curPrice > 0 && c.curPrice < 1;
            if (!hasValidPrice) {
              const isNew = !(asset in pprev);
              console.log(
                `${fmtTime()} | WAIT-PRICE | ${user} | ${c.slug ?? asset.slice(0, 12)} curPrice=${c.curPrice}` +
                (isNew ? " – new position, deferring until price is valid" : " – position increase, skipping cycle")
              );
              if (isNew) invalidNewAssets.add(asset);
              continue;
            }
            const trade: LeaderTrade = {
              id: `${user}-${asset}-${Date.now()}`,
              asset_id: asset,
              market: c.conditionId,
              side: "BUY",
              size: String(delta),
              price: String(c.curPrice),
              match_time: String(Date.now()),
              slug: c.slug,
              outcome: c.outcome,
              endDate: c.endDate,
            };
            onTrade(trade, user);
          } else if (delta < 0 && s > 0) {
            const trade: LeaderTrade = {
              id: `${user}-${asset}-${Date.now()}`,
              asset_id: asset,
              market: c.conditionId,
              side: "SELL",
              size: String(-delta),
              price: String(c.curPrice),
              match_time: String(Date.now()),
              slug: c.slug,
              outcome: c.outcome,
              endDate: c.endDate,
            };
            onTrade(trade, user);
          }
        }
        for (const asset of Object.keys(pprev)) {
          if (!(asset in curr)) {
            const s = pprev[asset];
            // If the market's scheduled end date is in the past, the position
            // disappeared because the market resolved — emit REDEEM so the bot
            // can reclaim its USDC on-chain instead of trying a doomed CLOB sell.
            const side = isExpired(s.endDate) ? "REDEEM" : "SELL";
            const trade: LeaderTrade = {
              id: `${user}-${asset}-${Date.now()}`,
              asset_id: asset,
              market: s.conditionId,
              side,
              size: String(s.size),
              price: String(s.curPrice),
              match_time: String(Date.now()),
              slug: s.slug,
              outcome: s.outcome,
              endDate: s.endDate,
            };
            onTrade(trade, user);
          }
        }
        // Build the next snapshot excluding positions that are brand-new
        // with an invalid price. Omitting them keeps them "unseen" in prev so
        // the next poll re-fires the BUY check once the data API returns a
        // proper price. All previously-tracked assets and new assets with
        // valid prices are carried forward normally.
        if (invalidNewAssets.size > 0) {
          const nextPrev: PositionSnapshot = {};
          for (const [asset, c] of Object.entries(curr)) {
            if (!invalidNewAssets.has(asset)) nextPrev[asset] = c;
          }
          prev[user] = nextPrev;
        } else {
          prev[user] = curr;
        }
      } catch (e) {
        console.error(`${fmtTime()} | poll ${user}`, e?.message ?? e);
      }
    }
  }

  console.log(`${fmtTime()} | polling ${targets.length} targets every ${config.copy.pollIntervalSec}s`);
  poll();
  setInterval(poll, intervalMs);
}

/** Fetches positions for UI only (no trade callbacks). Use for single-target websocket mode. */
export function runPositionsUiPoll(config: AppConfig): void {
  const targets = config.copy.targetAddresses.map((a) => a.toLowerCase());
  const intervalMs = Math.max(10000, config.copy.pollIntervalSec * 1000);
  async function poll() {
    for (const user of targets) {
      try {
        const positions = await fetchPositions(user);
        const curr = positions.map((p) => ({
          asset_id: p.asset,
          slug: p.slug,
          outcome: p.outcome,
          size: p.size,
          curPrice: p.curPrice,
        }));
        setPositions(user, curr);
      } catch (e) {
        /* ignore for UI */
      }
    }
  }
  poll();
  setInterval(poll, intervalMs);
}
