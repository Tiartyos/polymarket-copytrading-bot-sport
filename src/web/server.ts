import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { getState } from "./state";
import { getRecentTrades, getTradeById } from "../db/queries";

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
