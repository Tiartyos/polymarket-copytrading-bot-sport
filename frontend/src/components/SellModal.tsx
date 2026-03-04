import { useState } from "react";
import { sellPosition } from "../api/client";
import type { PositionSummary } from "../types/state";

interface SellModalProps {
  position: PositionSummary;
  onClose: () => void;
  onSold: () => void;
}

export function SellModal({ position, onClose, onSold }: SellModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const estimatedProceeds = (position.size * position.curPrice).toFixed(2);

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    try {
      const result = await sellPosition(position.asset_id, position.size, position.curPrice);
      if (result.success) {
        setTxHash(result.transaction_hash ?? null);
        onSold();
      } else {
        setError(result.error ?? "Sell failed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  const isDone = txHash !== null;

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={(e) => { if (e.target === e.currentTarget && !loading) onClose(); }}
    >
      <div className="bg-[#1a1a1a] border border-[#444] rounded-lg p-5 w-[340px] shadow-2xl text-sm">
        {/* Header */}
        <h2 className="text-white font-semibold text-base mb-4">
          {isDone ? "✅ Position Sold" : "Sell Position"}
        </h2>

        {/* Position details */}
        <div className="bg-[#252525] rounded p-3 mb-4 space-y-1 text-[12px]">
          <div className="flex justify-between">
            <span className="text-[#888]">Market</span>
            <span className="text-[#ccc] break-all text-right max-w-[200px]">{position.slug}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[#888]">Outcome</span>
            <span className="text-[#aaa] font-medium">{position.outcome}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[#888]">Size</span>
            <span className="text-[#ccc] tabular-nums">{position.size.toFixed(4)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[#888]">Current price</span>
            <span className="text-[#ccc] tabular-nums">{position.curPrice}</span>
          </div>
          <div className="flex justify-between border-t border-[#333] pt-1 mt-1">
            <span className="text-[#888]">Est. proceeds</span>
            <span className="text-[#6f6] font-semibold tabular-nums">${estimatedProceeds}</span>
          </div>
        </div>

        {/* Success tx hash */}
        {isDone && txHash && (
          <div className="mb-4 bg-[#1a2b1a] border border-[#2d4d2d] rounded p-2 text-[11px] break-all text-[#6f6]">
            Tx: {txHash}
          </div>
        )}
        {isDone && !txHash && (
          <div className="mb-4 text-[11px] text-[#888]">Order submitted (no tx hash returned).</div>
        )}

        {/* Error */}
        {error && (
          <div className="mb-4 bg-[#2b1a1a] border border-[#4d2d2d] rounded p-2 text-[11px] text-[#f88]">
            {error}
          </div>
        )}

        {/* Buttons */}
        <div className="flex gap-2 justify-end">
          {!isDone && (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={loading}
                className="px-3 py-1.5 rounded text-[12px] bg-[#2a2a2a] hover:bg-[#333] text-[#aaa] disabled:opacity-40 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={loading}
                className="px-4 py-1.5 rounded text-[12px] bg-[#b03030] hover:bg-[#cc3333] text-white font-semibold disabled:opacity-40 cursor-pointer flex items-center gap-1.5"
              >
                {loading && (
                  <span className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                )}
                {loading ? "Selling…" : "Confirm Sell"}
              </button>
            </>
          )}
          {isDone && (
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded text-[12px] bg-[#2a2a2a] hover:bg-[#333] text-white cursor-pointer"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
