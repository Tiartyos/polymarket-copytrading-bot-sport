import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { getState, getClient, getBotPositionSizes } from "./state";
import { getRecentTrades, getTradeById, getMyOpenFills } from "../db/queries";

const FALLBACK_PUBLIC = path.join(__dirname, "public");
const UI_DIST = path.join(process.cwd(), "frontend", "dist");

function getPublicDir(): string {
  const indexPath = path.join(UI_DIST, "index.html");
  if (fs.existsSync(indexPath)) return UI_DIST;
  return FALLBACK_PUBLIC;
}

const MIMES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export function startWebServer(port: number): void {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const urlPath = url.split("?")[0];

    // ── Health check ──────────────────────────────────────────────────────────
    if (urlPath === "/api/health") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
      return;
    }

    // ── Bot state ─────────────────────────────────────────────────────────────
    if (urlPath === "/api/state") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end(JSON.stringify(getState()));
      return;
    }

    // ── My open positions (filled buys from DB, filtered to currently-held assets) ─────
    if (urlPath === "/api/my-positions") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      try {
        const fills = getMyOpenFills();
        const live = getBotPositionSizes();
        // If we have live data, only show positions the bot wallet still holds.
        // If live cache is empty (e.g. simulation / not yet polled), show all DB fills.
        const result = live.size > 0
          ? fills.filter((f) => live.has(f.asset_id))
          : fills;
        res.end(JSON.stringify(result));
      } catch {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "db unavailable" }));
      }
      return;
    }

    // ── Trade history ─────────────────────────────────────────────────────────
    if (urlPath === "/api/trades") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      try {
        const qs = new URLSearchParams(url.includes("?") ? url.split("?")[1] : "");
        const limit = Math.min(parseInt(qs.get("limit") ?? "100", 10), 500);
        res.end(JSON.stringify(getRecentTrades(limit)));
      } catch {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "db unavailable" }));
      }
      return;
    }

    // ── Single trade by id ───────────────────────────────────────────────────
    const tradeMatch = urlPath.match(/^\/api\/trades\/(\d+)$/);
    if (tradeMatch) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      try {
        const trade = getTradeById(parseInt(tradeMatch[1], 10));
        if (!trade) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not found" }));
        } else {
          res.end(JSON.stringify(trade));
        }
      } catch {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "db unavailable" }));
      }
      return;
    }

    // ── Manual sell position ─────────────────────────────────────────────────
    if (urlPath === "/api/positions/sell" && req.method === "POST") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { asset_id, size, price } = JSON.parse(body) as { asset_id: string; size: number; price: number };
          if (!asset_id || !size || !price) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, error: "asset_id, size and price are required" }));
            return;
          }
          const client = getClient();
          if (!client) {
            res.statusCode = 503;
            res.end(JSON.stringify({ success: false, error: "Bot is in simulation mode — no client available" }));
            return;
          }
          const { OrderType, Side } = await import("@polymarket/clob-client");
          const tickSize = await client.getTickSize(asset_id);
          const negRisk = await client.getNegRisk(asset_id);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const resp: any = await client.createAndPostMarketOrder(
            { tokenID: asset_id, amount: size, side: Side.SELL, orderType: OrderType.FOK },
            { tickSize, negRisk },
            OrderType.FOK
          );
          const txHash = resp?.transactionsHashes?.[0] ?? resp?.transactionHash ?? resp?.transaction_hash ?? null;
          res.end(JSON.stringify({ success: true, transaction_hash: txHash }));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: msg }));
        }
      });
      return;
    }

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.statusCode = 204;
      res.end();
      return;
    }
    const publicDir = getPublicDir();
    const file = req.url === "/" ? "index.html" : (req.url ?? "/").replace(/^\//, "").split("?")[0];
    const filePath = path.join(publicDir, file);
    const normalized = path.normalize(filePath);
    if (!normalized.startsWith(path.normalize(publicDir))) {
      res.statusCode = 403;
      res.end();
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (publicDir === UI_DIST && !file.includes(".")) {
          fs.readFile(path.join(publicDir, "index.html"), (e2, html) => {
            if (e2) {
              res.statusCode = 404;
              res.end();
              return;
            }
            res.setHeader("Content-Type", "text/html");
            res.end(html);
          });
          return;
        }
        res.statusCode = 404;
        res.end();
        return;
      }
      const ext = path.extname(file);
      res.setHeader("Content-Type", MIMES[ext] ?? "application/octet-stream");
      res.end(data);
    });
  });
  server.listen(port, () => console.log(`UI http://localhost:${port}`));
}
