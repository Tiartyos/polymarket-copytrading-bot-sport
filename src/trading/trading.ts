import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import Big from "big.js";
import type { LeaderTrade, ActivityTradePayload } from "../types";
import { isAlreadyCopied, insertCopiedTrade, updateTradeStatus } from "../db/queries";

export async function copyTrade(
  client: ClobClient,
  trade: LeaderTrade,
  multiplier: number,
  chainId: number,
  buyAmountLimitInUsd: number = 0,
  leaderAddress: string = "unknown"
): Promise<{ size: number; price: number } | void> {
  // ── Duplicate prevention ────────────────────────────────────────────────────
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

  const amountUsd = trade.side === Side.BUY
    ? sizeOutB.times(priceB).toFixed(4)
    : amountB.toFixed(4);

  // ── Persist as PENDING before hitting the network ──────────────────────────
  insertCopiedTrade(trade.id, leaderAddress, trade, amountUsd);

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
    txHash = resp?.transactionHash ?? resp?.transaction_hash ?? resp?.orderID ?? undefined;
    updateTradeStatus(trade.id, "FILLED", txHash);
  } catch (err) {
    updateTradeStatus(trade.id, "FAILED");
    throw err;
  }

  if (trade.side === Side.BUY) {
    return { size: sizeOutB.toNumber(), price: priceB.toNumber() };
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
