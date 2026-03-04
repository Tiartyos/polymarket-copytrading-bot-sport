import { useState, useMemo } from "react";
import type { TradeLog } from "../../types/state";

type Filter = "all" | "ok" | "failed" | "skip";

const FILTER_OPTS: { key: Filter; label: string; dot: string }[] = [
  { key: "all",    label: "All",    dot: "bg-[#555]" },
  { key: "ok",     label: "✓ OK",   dot: "bg-[#4a4]" },
  { key: "failed", label: "✗ Failed", dot: "bg-[#a44]" },
  { key: "skip",   label: "─ Skip", dot: "bg-[#555]" },
];

function statusFilter(r: TradeLog): Filter {
  const s = r.copyStatus?.toLowerCase() ?? "";
  if (s === "ok") return "ok";
  if (s === "failed") return "failed";
  return "skip";
}

function StatusBadge({ copyStatus }: { copyStatus?: string }) {
  const s = copyStatus?.toLowerCase() ?? "";
  if (s === "ok") return (
    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#1a3d1a] text-[#6f6] border border-[#2a5a2a]">ok</span>
  );
  if (s === "failed") return (
    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#3d1a1a] text-[#f66] border border-[#5a2020]">FAILED</span>
  );
  return (
    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] text-[#555]">{copyStatus ?? "—"}</span>
  );
}

interface LogPageProps {
  logs: TradeLog[];
}

export function LogPage({ logs }: LogPageProps) {
  const [filter, setFilter] = useState<Filter>("all");

  const counts = useMemo(() => {
    const c = { all: logs.length, ok: 0, failed: 0, skip: 0 };
    for (const r of logs) { c[statusFilter(r)]++; }
    return c;
  }, [logs]);

  const rows = useMemo(() => {
    const reversed = [...logs].reverse();
    if (filter === "all") return reversed;
    return reversed.filter((r) => statusFilter(r) === filter);
  }, [logs, filter]);

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Filter bar */}
      <div className="shrink-0 flex items-center gap-1 mb-2 flex-wrap">
        {FILTER_OPTS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer border ${
              filter === key
                ? key === "ok"    ? "bg-[#1a3d1a] border-[#2a5a2a] text-[#6f6]"
                : key === "failed"? "bg-[#3d1a1a] border-[#5a2020] text-[#f66]"
                : "bg-[#2a2a2a] border-[#444] text-[#aaa]"
                : "bg-transparent border-[#333] text-[#666] hover:text-[#999] hover:border-[#444]"
            }`}
          >
            {label} <span className="opacity-60">({counts[key]})</span>
          </button>
        ))}
        <span className="text-[10px] text-[#555] ml-auto">{rows.length} row(s)</span>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-[#111] z-10">
            <tr>
              <th className="p-2 text-left text-[#666] font-medium border-b border-[#333] whitespace-nowrap">Time</th>
              <th className="p-2 text-left text-[#666] font-medium border-b border-[#333]">Side</th>
              <th className="p-2 text-left text-[#666] font-medium border-b border-[#333]">Outcome</th>
              <th className="p-2 text-right text-[#666] font-medium border-b border-[#333] tabular-nums">Size</th>
              <th className="p-2 text-right text-[#666] font-medium border-b border-[#333] tabular-nums">Price</th>
              <th className="p-2 text-right text-[#666] font-medium border-b border-[#333] tabular-nums">USD</th>
              <th className="p-2 text-left text-[#666] font-medium border-b border-[#333]">Market</th>
              <th className="p-2 text-left text-[#666] font-medium border-b border-[#333]">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const sf = statusFilter(r);
              const rowCls = sf === "ok"
                ? "border-b border-[#1e2e1e] hover:bg-[#141e14]"
                : sf === "failed"
                ? "border-b border-[#2e1e1e] hover:bg-[#1e1414]"
                : "border-b border-[#252525] hover:bg-[#1a1a1a] opacity-40";
              return (
                <tr key={`${r.time}-${i}`} className={rowCls}>
                  <td className="p-2 text-[#555] whitespace-nowrap tabular-nums">{r.time.slice(11, 19)}</td>
                  <td className={`p-2 font-semibold ${r.side === "BUY" ? "text-[#6f6]" : "text-[#f66]"}`}>{r.side}</td>
                  <td className="p-2 text-[#aaa]">{r.outcome}</td>
                  <td className="p-2 text-right tabular-nums text-[#888]">
                    {r.size != null && r.size !== "" ? Number(r.size).toFixed(2) : "—"}
                  </td>
                  <td className="p-2 text-right tabular-nums text-[#888]">{r.price}</td>
                  <td className="p-2 text-right tabular-nums text-[#7af] whitespace-nowrap">
                    {r.amountUsd != null ? `$${r.amountUsd.toFixed(2)}` : ""}
                  </td>
                  <td className="p-2 text-[#ccc] max-w-[200px] truncate" title={r.slug}>{r.slug}</td>
                  <td className="p-2 whitespace-nowrap"><StatusBadge copyStatus={r.copyStatus} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="text-center text-[#555] text-sm py-8">No entries for this filter.</p>
        )}
      </div>
    </div>
  );
}
