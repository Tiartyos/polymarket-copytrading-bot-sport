import { useState, useMemo, useEffect } from "react";
import type { PositionSummary } from "../../types/state";
import { SellModal } from "../../components/SellModal";
import { fetchMyPositions, type MyFillRow } from "../../api/client";

interface PositionsPanelProps {
  targetAddresses: string[];
  positions: Record<string, PositionSummary[]>;
  deltaHighlightSec: number;
  deltaAnimationSec: number;
}

function fmtDuration(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── My Bot Positions ──────────────────────────────────────────────────────────

function MyPositionsSection() {
  const [fills, setFills] = useState<MyFillRow[]>([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    fetchMyPositions().then(setFills).catch(() => {});
    const t = setInterval(() => fetchMyPositions().then(setFills).catch(() => {}), 8000);
    return () => clearInterval(t);
  }, []);

  const totalUsd = fills.reduce((s, r) => s + r.totalUsd, 0);

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 w-full text-left mb-1 cursor-pointer"
      >
        <span className={`text-[10px] text-[#6af] transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
        <span className="text-[11px] font-semibold text-[#6af] uppercase tracking-wide">My Bot Positions</span>
        <span className="ml-auto text-[10px] text-[#555] tabular-nums">
          {fills.length > 0 && `${fills.length} market${fills.length !== 1 ? "s" : ""} · $${totalUsd.toFixed(2)} in`}
        </span>
      </button>

      {open && (
        fills.length === 0 ? (
          <p className="text-[11px] text-[#555] pl-3 py-1">No filled buys in DB yet.</p>
        ) : (
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr>
                <th className="text-[#555] font-medium text-left py-0.5 pr-2 border-b border-[#222]">Market</th>
                <th className="text-[#555] font-medium text-right py-0.5 pr-2 border-b border-[#222] tabular-nums">Size</th>
                <th className="text-[#555] font-medium text-right py-0.5 pr-2 border-b border-[#222] tabular-nums">Avg</th>
                <th className="text-[#555] font-medium text-right py-0.5 border-b border-[#222] tabular-nums">Cost</th>
              </tr>
            </thead>
            <tbody>
              {fills.map((r, i) => {
                const label = r.market_id.length > 26 ? r.market_id.slice(0, 24) + "…" : r.market_id;
                return (
                  <tr key={`${r.asset_id}-${i}`} className="border-b border-[#1a1a1a] hover:bg-[#141e14]">
                    <td className="py-1 pr-2 text-[#adf] break-words cursor-default" title={`${r.market_id}\n${r.asset_id}`}>
                      {label}
                      {r.fillCount > 1 && <span className="ml-1 text-[#444] text-[9px]">×{r.fillCount}</span>}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums text-[#6f6]">{r.totalSize.toFixed(2)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums text-[#888]">{r.avgPrice.toFixed(3)}</td>
                    <td className="py-1 text-right tabular-nums text-[#7af] whitespace-nowrap">${r.totalUsd.toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
            {fills.length > 1 && (
              <tfoot>
                <tr>
                  <td colSpan={3} className="pt-1 text-right text-[#555] text-[10px]">Total</td>
                  <td className="pt-1 text-right tabular-nums text-[#7af] font-semibold">${totalUsd.toFixed(2)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        )
      )}
      <div className="border-b border-[#222] mt-3" />
    </div>
  );
}

// ── Tracked traders ───────────────────────────────────────────────────────────

function UserBlock({
  addr,
  positions: rawPos,
  deltaHighlightSec,
  deltaAnimationSec,

}: {
  addr: string;
  positions: PositionSummary[];
  deltaHighlightSec: number;
  deltaAnimationSec: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [sellingPosition, setSellingPosition] = useState<PositionSummary | null>(null);
  const recentByKey = useMemo(() => ({ current: {} as Record<string, number> }), []);
  const key = addr + "|";
  rawPos.forEach((p) => {
    const pk = key + (p.slug ?? "?") + "|" + (p.outcome ?? "?");
    if (p.delta != null && p.deltaAt)
      recentByKey.current[pk] = new Date(p.deltaAt).getTime();
  });
  const positions = useMemo(() => {
    const now = Date.now();
    return [...rawPos].sort((a, b) => {
      const aKey = key + (a.slug ?? "?") + "|" + (a.outcome ?? "?");
      const bKey = key + (b.slug ?? "?") + "|" + (b.outcome ?? "?");
      const aAt = a.deltaAt ? new Date(a.deltaAt).getTime() : recentByKey.current[aKey];
      const bAt = b.deltaAt ? new Date(b.deltaAt).getTime() : recentByKey.current[bKey];
      const aRecent = aAt && now - aAt < deltaHighlightSec * 1000 ? 1 : 0;
      const bRecent = bAt && now - bAt < deltaHighlightSec * 1000 ? 1 : 0;
      if (aRecent !== bRecent) return bRecent - aRecent;
      return 0;
    });
  }, [rawPos, key, deltaHighlightSec, recentByKey]);

  const mostRecentAt = positions.reduce(
    (acc, p) => (p.deltaAt ? Math.max(acc, new Date(p.deltaAt).getTime()) : acc),
    0
  );
  const atStr = mostRecentAt ? fmtDuration(new Date(mostRecentAt).toISOString()) : "";
  const summary = `${positions.length} position(s)${atStr ? ` • ${atStr}` : ""}`;

  return (
    <div className="mb-4 last:mb-0">
      {sellingPosition && (
        <SellModal
          position={sellingPosition}
          onClose={() => setSellingPosition(null)}
          onSold={() => setSellingPosition(null)}
        />
      )}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-1.5 w-full text-left hover:text-white cursor-pointer"
      >
        <span
          className={`text-[10px] text-[#666] transition-transform ${expanded ? "rotate-90 text-[#8af]" : ""}`}
        >
          ▶
        </span>
        <span className="font-mono text-[11px] text-[#8af] break-all">{addr}</span>
      </button>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="block w-full mt-1.5 mb-2 text-left text-[11px] p-2 bg-[#252525] border border-[#333] rounded cursor-pointer hover:bg-[#2a2a2a]"
      >
        {summary}
      </button>
      {expanded && (
        <div className="mt-2">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr>
                <th className="text-[#888] font-medium text-left py-1 pr-2 border-b border-[#333]">
                  Slug
                </th>
                <th className="text-[#888] font-medium text-left py-1 pr-2 border-b border-[#333]">
                  Outcome
                </th>
                <th className="text-[#888] font-medium text-left py-1 pr-2 border-b border-[#333]">
                  Size
                </th>
                <th className="text-[#888] font-medium text-left py-1 pr-2 border-b border-[#333]">
                  Price
                </th>
                <th className="text-[#888] font-medium text-right py-1 pr-2 border-b border-[#333]">
                  Δ
                </th>
                <th className="text-[#888] font-medium text-right py-1 border-b border-[#333]" />
              </tr>
            </thead>
            <tbody>
              {positions.map((p, i) => {
                const deltaCls =
                  p.delta != null
                    ? p.delta > 0
                      ? "text-[#6f6] font-semibold"
                      : "text-[#f66] font-semibold"
                    : "";
                const deltaStr =
                  p.delta != null ? (p.delta > 0 ? "+" : "") + Number(p.delta).toFixed(2) : "";
                const deltaStyle =
                  p.delta != null
                    ? { animation: `deltaFlash ${deltaAnimationSec}s ease-out forwards` }
                    : undefined;
                return (
                  <tr key={`${p.slug}-${p.outcome}-${i}`} className="border-b border-[#2a2a2a] last:border-0">
                    <td className="py-1 pr-2 text-[#ccc] break-words" title={p.slug}>
                      {p.slug ?? "?"}
                    </td>
                    <td className="py-1 pr-2 text-[#aaa] font-medium">{p.outcome ?? "?"}</td>
                    <td className="py-1 pr-2 text-[#888] tabular-nums whitespace-nowrap">
                      {p.size}
                    </td>
                    <td className="py-1 pr-2 text-[#888] tabular-nums whitespace-nowrap">
                      {p.curPrice}
                    </td>
                    <td className={`py-1 pr-2 text-right tabular-nums min-w-[3.5em] ${deltaCls}`} style={deltaStyle}>
                      {deltaStr}
                    </td>
                    <td className="py-1 text-right whitespace-nowrap">
                      {p.size > 0 && p.asset_id && (
                        <button
                          type="button"
                          onClick={() => setSellingPosition(p)}
                          className="px-1.5 py-0.5 rounded text-[10px] bg-[#3d1a1a] hover:bg-[#5a2020] text-[#f88] border border-[#5a2020] hover:border-[#cc3333] cursor-pointer transition-colors"
                        >
                          Sell
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function PositionsPanel({
  targetAddresses,
  positions,
  deltaHighlightSec,
  deltaAnimationSec,
}: PositionsPanelProps) {
  const [trackersOpen, setTrackersOpen] = useState(false);
  const users = targetAddresses?.length ? targetAddresses : Object.keys(positions);

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#111] p-3 flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="overflow-y-auto overflow-x-hidden flex-1 min-h-0">
        {/* Bot's own fills from DB */}
        <MyPositionsSection />

        {/* Tracked traders — collapsed by default */}
        <div>
          <button
            type="button"
            onClick={() => setTrackersOpen((o) => !o)}
            className="flex items-center gap-1.5 w-full text-left cursor-pointer mb-1"
          >
            <span className={`text-[10px] text-[#555] transition-transform ${trackersOpen ? "rotate-90 text-[#8af]" : ""}`}>▶</span>
            <span className="text-[11px] font-semibold text-[#555] uppercase tracking-wide">Tracked Traders</span>
            <span className="ml-auto text-[10px] text-[#444]">{users.length} addr</span>
          </button>
          {trackersOpen && users.map((addr) => {
            const posKey = Object.keys(positions).find(
              (k) => k.toLowerCase() === addr.toLowerCase()
            );
            const pos = posKey ? (positions[posKey] ?? []) : [];
            return (
              <UserBlock
                key={addr}
                addr={addr}
                positions={pos}
                deltaHighlightSec={deltaHighlightSec}
                deltaAnimationSec={deltaAnimationSec}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
