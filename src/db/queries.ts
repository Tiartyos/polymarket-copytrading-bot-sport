import { getDb } from "./index";
import type { LeaderTrade } from "../types";

export type TradeStatus = "PENDING" | "FILLED" | "FAILED";

interface CopiedTradeRow {
  id: number;
  leader_trade_id: string;
  leader_address: string;
  asset_id: string;
  market_id: string;
  side: string;
  size: string;
  price: string;
  amount_usd: string;
  /** Polymarket internal order ID — off-chain abstraction, visible in Polymarket API */
  polymarket_order_id: string | null;
  /** Real on-chain Polygon transaction hash — verifiable on Polygonscan */
  transaction_hash: string | null;
  status: TradeStatus;
  timestamp: string;
  entry_price: string | null;
  exit_price: string | null;
  pnl: string | null;
  pnl_pct: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Returns true if this trade ID was already FILLED — skip copying.
 * PENDING/FAILED records are allowed to retry.
 */
export function isAlreadyCopied(leaderTradeId: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT status FROM copied_trades WHERE leader_trade_id = ?")
    .get(leaderTradeId) as Pick<CopiedTradeRow, "status"> | undefined;
  return row?.status === "FILLED";
}

/**
 * Inserts a new PENDING record. Uses INSERT OR IGNORE so concurrent
 * calls race safely — only one will win and the others are no-ops.
 * Returns the rowid, or 0 if the row was already there (ignored).
 */
export function insertCopiedTrade(
  leaderTradeId: string,
  leaderAddress: string,
  trade: LeaderTrade,
  amountUsd: string
): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO copied_trades
         (leader_trade_id, leader_address, asset_id, market_id, side, size, price, amount_usd, status, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`
    )
    .run(
      leaderTradeId,
      leaderAddress,
      trade.asset_id,
      trade.market,
      trade.side,
      trade.size,
      trade.price,
      amountUsd,
      new Date().toISOString()
    );
  return Number(result.lastInsertRowid);
}

/**
 * Updates the status, and optionally the Polymarket order ID and on-chain tx hash.
 * @param txHash         Real Polygon transaction hash (verifiable on Polygonscan)
 * @param polymarketOrderId  Polymarket's internal orderID (off-chain layer)
 */
export function updateTradeStatus(
  leaderTradeId: string,
  status: TradeStatus,
  txHash?: string,
  polymarketOrderId?: string
): void {
  const db = getDb();
  db.prepare(
    `UPDATE copied_trades
     SET status = ?,
         transaction_hash     = COALESCE(?, transaction_hash),
         polymarket_order_id  = COALESCE(?, polymarket_order_id),
         updated_at = datetime('now')
     WHERE leader_trade_id = ?`
  ).run(status, txHash ?? null, polymarketOrderId ?? null, leaderTradeId);
}

/**
 * Stores the averaged entry price once a BUY is confirmed.
 */
export function updateEntryPrice(leaderTradeId: string, entryPrice: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE copied_trades
     SET entry_price = ?, updated_at = datetime('now')
     WHERE leader_trade_id = ?`
  ).run(entryPrice, leaderTradeId);
}

export interface MyFillRow {
  asset_id: string;
  market_id: string;
  totalSize: number;
  totalUsd: number;
  avgPrice: number;
  latestAt: string;
  fillCount: number;
}

/**
 * Group all FILLED BUY trades by asset — used for the "My Positions" UI panel.
 */
export function getMyOpenFills(): MyFillRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT
         asset_id,
         market_id,
         SUM(CAST(size       AS REAL)) AS totalSize,
         SUM(CAST(amount_usd AS REAL)) AS totalUsd,
         AVG(CAST(price      AS REAL)) AS avgPrice,
         MAX(timestamp)                AS latestAt,
         COUNT(*)                      AS fillCount
       FROM copied_trades
       WHERE status = 'FILLED' AND side = 'BUY'
       GROUP BY asset_id
       ORDER BY latestAt DESC`
    )
    .all() as MyFillRow[];
}

/**
 * Query helpers for UI / analytics use.
 */
export function getRecentTrades(limit = 100): CopiedTradeRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM copied_trades ORDER BY created_at DESC LIMIT ?")
    .all(limit) as CopiedTradeRow[];
}

export function getTradesByLeader(leaderAddress: string): CopiedTradeRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM copied_trades WHERE leader_address = ? ORDER BY created_at DESC")
    .all(leaderAddress) as CopiedTradeRow[];
}

export function getTradesByStatus(status: TradeStatus): CopiedTradeRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM copied_trades WHERE status = ? ORDER BY created_at DESC")
    .all(status) as CopiedTradeRow[];
}

export function getTradeById(id: number): CopiedTradeRow | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM copied_trades WHERE id = ?")
    .get(id) as CopiedTradeRow | undefined;
}

export function getTradeByTxHash(txHash: string): CopiedTradeRow | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM copied_trades WHERE transaction_hash = ?")
    .get(txHash) as CopiedTradeRow | undefined;
}

/**
 * On startup: any trade still PENDING is stale (bot crashed before execution
 * result was received). Since FOK orders are fire-and-forget, we cannot safely
 * assume they filled — mark them FAILED so they're eligible for retry.
 */
export function reconcileStalePending(): number {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE copied_trades
       SET status = 'FAILED', updated_at = datetime('now')
       WHERE status = 'PENDING'`
    )
    .run();
  return result.changes;
}
