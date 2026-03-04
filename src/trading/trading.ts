import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import Big from "big.js";
import type { LeaderTrade, ActivityTradePayload } from "../types";
import { isAlreadyCopied, insertCopiedTrade, updateTradeStatus } from "../db/queries";

// ── Sequential order queue ───────────────────────────────────────────────────
// All trade executions are serialized through this chain so concurrent poll
// events cannot simultaneously drain the wallet balance (race condition fix).
let _orderQueue: Promise<void> = Promise.resolve();

export async function copyTrade(
  client: ClobClient,
  trade: LeaderTrade,
  multiplier: number,
  chainId: number,
  buyAmountLimitInUsd: number = 0,
  leaderAddress: string = "unknown"
): Promise<{ size: number; price: number; amountUsd: number } | undefined> {
  return new Promise((resolve, reject) => {
    _orderQueue = _orderQueue.then(() =>
      _executeCopyTrade(client, trade, multiplier, chainId, buyAmountLimitInUsd, leaderAddress)
        .then(resolve, reject)
    );
  });
}

async function _executeCopyTrade(
  client: ClobClient,
  trade: LeaderTrade,
  multiplier: number,
  chainId: number,
  buyAmountLimitInUsd: number,
  leaderAddress: string
): Promise<{ size: number; price: number; amountUsd: number } | undefined> {
  // ── Duplicate prevention ──────────────────────────────────────────────────
  if (isAlreadyCopied(trade.id)) {
    console.log(`[DB] Skipping duplicate trade ${trade.id}`);
    return;
  }

  const sizeB = new Big(trade.size);
  const priceB = new Big(trade.price);
  const multB = new Big(multiplier);
  let amountB =
    trade.side === Side.BUY ? sizeB.times(priceB).times(multB) : sizeB.times(multB);
  let sizeOutB = sizeB;

  if (trade.side === Side.BUY && buyAmountLimitInUsd > 0) {
    const amountUsdB = sizeB.times(priceB).times(multB);
    const limitB = new Big(buyAmountLimitInUsd);
    if (amountUsdB.gt(limitB)) {
      amountB = limitB;
      sizeOutB = limitB.div(priceB);
    }
  }

  if (amountB.lte(0)) return;

  // ── Minimum order guard ($1.00 Polymarket floor) ──────────────────────────
  const MIN_ORDER_USD = new Big("1.0");
  if (amountB.lt(MIN_ORDER_USD)) {
    console.log(`[SKIP] Scaled order $${amountB.toFixed(4)} < $1.00 min — skipping trade ${trade.id}`);
    return;
  }

  const amountUsd = amountB.toNumber();
  const amountUsdStr = amountB.toFixed(4);

  // ── Persist as PENDING before hitting the network ────────────────────────
  insertCopiedTrade(trade.id, leaderAddress, trade, amountUsdStr);

  const amount = amountB.toNumber();
  const order = {
    tokenID: trade.asset_id,
    amount,
    side: trade.side as Side,
    orderType: OrderType.FOK as OrderType.FOK,
  };

  const tickSize = await client.getTickSize(trade.asset_id);
  const negRisk = await client.getNegRisk(trade.asset_id);

  let txHash: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp: any = await client.createAndPostMarketOrder(order, { tickSize, negRisk }, OrderType.FOK);
    // The CLOB client catches HTTP errors internally and may return null or an
    // error-carrying object instead of throwing. Treat both as failures.
    if (!resp || resp.error || resp.errorCode) {
      const msg = resp?.error ?? resp?.errorCode ?? "null response from CLOB client";
      throw new Error(`Order rejected: ${msg}`);
    }
    txHash = resp?.transactionHash ?? resp?.transaction_hash ?? resp?.orderID ?? undefined;
    updateTradeStatus(trade.id, "FILLED", txHash);
  } catch (err) {
    updateTradeStatus(trade.id, "FAILED");
    throw err;
  }

  if (trade.side === Side.BUY) {
    return { size: sizeOutB.toNumber(), price: priceB.toNumber(), amountUsd };
  }
}

export function activityPayloadToLeaderTrade(p: ActivityTradePayload): LeaderTrade | null {
  if (!p.asset || p.side == null || p.size == null || p.price == null) return null;
  const id = (p.transactionHash ?? "") + (p.timestamp ?? 0);
  return {
    id,
    asset_id: p.asset,
    market: p.conditionId ?? "",
    side: p.side,
    size: String(p.size),
    price: String(p.price),
    match_time: String(p.timestamp ?? 0),
    slug: p.slug,
    eventSlug: p.eventSlug,
    outcome: p.outcome,
    title: p.title,
  };
}
