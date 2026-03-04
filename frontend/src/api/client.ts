import type { BotState } from "../types/state";

const API_BASE = "";

export async function fetchState(): Promise<BotState> {
  const res = await fetch(`${API_BASE}/api/state`);
  if (!res.ok) throw new Error("Failed to fetch state");
  return res.json();
}

export interface SellResult {
  success: boolean;
  transaction_hash?: string | null;
  error?: string;
}

export async function sellPosition(
  asset_id: string,
  size: number,
  price: number
): Promise<SellResult> {
  const res = await fetch(`${API_BASE}/api/positions/sell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ asset_id, size, price }),
  });
  return res.json();
}
