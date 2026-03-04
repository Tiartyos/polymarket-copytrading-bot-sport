/**
 * sell-all.ts — Debug utility: sell every open position at current market price.
 *
 * Reads the local DB for all FILLED BUY positions, cross-references with the
 * Polymarket live positions API to get the actual on-chain size, then places a
 * FOK market-sell for each one.
 *
 * Usage:
 *   npm run sell-all
 *   npm run sell-all -- --dry-run   (print what would be sold, no orders placed)
 *
 * All credentials come from .env — nothing sensitive is in this file.
 */
import "dotenv/config";
import { Wallet, providers, Contract, utils, BigNumber } from "ethers";
import { ClobClient, Chain, SignatureType, Side, OrderType } from "@polymarket/clob-client";
import { loadConfig } from "../src/config";
import { initDb } from "../src/db";
import { getMyOpenFills } from "../src/db/queries";

// ── Polymarket contract addresses ─────────────────────────────────────────────
const CTF_TOKEN = utils.getAddress("0x4d97dcd97ec945f40cf65f87097ace5ea0476045");
const CTF_EXCHANGE = utils.getAddress("0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e");
const NEG_RISK_EXCHANGE = utils.getAddress("0xc5d563a36ae78145c45a50134d48a1215220f80a");
const NEG_RISK_ADAPTER = utils.getAddress("0xd91e80cf2e7be2e162c6513ced06f1dd0da35296");

const ERC1155_ABI = [
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
];

const DRY_RUN = process.argv.includes("--dry-run");
// --force: sell ALL live wallet positions regardless of DB state
const FORCE = process.argv.includes("--force");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Ensure the wallet can transfer outcome tokens on all exchange contracts. */
async function ensureCtfApprovals(signer: Wallet, provider: providers.JsonRpcProvider): Promise<void> {
  const ctf = new Contract(CTF_TOKEN, ERC1155_ABI, signer.connect(provider));
  const owner = signer.address;
  const feeData = await provider.getFeeData();
  const MIN_PRIORITY = BigNumber.from("30000000000"); // 30 gwei — Polygon minimum
  const priority = (feeData.maxPriorityFeePerGas ?? BigNumber.from(0)).gt(MIN_PRIORITY)
    ? feeData.maxPriorityFeePerGas!
    : MIN_PRIORITY;
  const gas: Record<string, unknown> = { maxPriorityFeePerGas: priority };
  if (feeData.maxFeePerGas) gas.maxFeePerGas = feeData.maxFeePerGas.add(priority);

  for (const [label, operator] of [
    ["CTF Exchange", CTF_EXCHANGE],
    ["NegRisk Exchange", NEG_RISK_EXCHANGE],
    ["NegRisk Adapter", NEG_RISK_ADAPTER],
  ] as [string, string][]) {
    const approved: boolean = await (ctf as any).isApprovedForAll(owner, operator);
    if (!approved) {
      if (DRY_RUN) { console.log(`  [dry-run] would setApprovalForAll → ${label}`); continue; }
      process.stdout.write(`  setApprovalForAll → ${label} ... `);
      const tx: any = await (ctf as any).setApprovalForAll(operator, true, gas);
      await tx.wait();
      console.log("✓");
    }
  }
}

/** Return bids sorted best (highest price) first.
 *  The CLOB /book endpoint returns them ascending (worst first). */
function bestBid(bids: Array<{ price: string; size: string }>): number {
  return bids.length === 0 ? 0 : Math.max(...bids.map((b) => Number(b.price)));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (DRY_RUN) console.log("── DRY RUN — no orders will be placed ──\n");
  if (FORCE) console.log("── FORCE MODE — selling all live wallet positions (ignoring DB) ──\n");
  initDb();

  const config = loadConfig();
  const { clobHost, chainId, walletPrivateKey, proxyWalletAddress, signatureType } = config;
  const chain = chainId === 137 ? Chain.POLYGON : Chain.AMOY;
  const pk = walletPrivateKey.startsWith("0x") ? walletPrivateKey : "0x" + walletPrivateKey;
  const provider = new providers.JsonRpcProvider(
    process.env.ALCHEMY_API_KEY
      ? `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
      : "https://polygon-rpc.com"
  );
  const wallet = new Wallet(pk);
  const funder = proxyWalletAddress || undefined;

  const envKey = process.env.API_KEY?.trim();
  const envSecret = process.env.API_SECRET?.trim();
  const envPassphrase = process.env.API_PASSPHRASE?.trim();
  const client = envKey && envSecret && envPassphrase
    ? new ClobClient(clobHost, chain, wallet, { key: envKey, secret: envSecret, passphrase: envPassphrase }, signatureType as SignatureType, funder)
    : new ClobClient(clobHost, chain, wallet, undefined, signatureType as SignatureType, funder);

  // ── Step 1: assets we hold according to the DB ──────────────────────────
  const dbFills = getMyOpenFills();
  if (!FORCE && dbFills.length === 0) {
    console.log("No FILLED BUY positions in DB — nothing to sell.");
    console.log("Tip: use --force to sell all live wallet positions regardless of DB.");
    return;
  }
  const dbAssets = new Set(dbFills.map((f) => f.asset_id));

  // ── Step 2: live sizes from Polymarket (source of truth for actual balance)
  const posResp = await fetch(
    `https://data-api.polymarket.com/positions?user=${wallet.address}&limit=100`
  );
  const livePositions = (await posResp.json()) as Array<{
    asset: string;
    size: number;
    curPrice: number;
    title: string;
    slug: string;
    negativeRisk: boolean;
  }>;

  // In force mode sell everything; otherwise filter by DB
  const toSell = FORCE
    ? livePositions.filter((p) => p.size > 0)
    : livePositions.filter((p) => dbAssets.has(p.asset));

  if (toSell.length === 0) {
    console.log("No live positions found" + (FORCE ? " in wallet" : " matching DB fills") + " — already sold or market resolved.");
    return;
  }

  // ── Step 3: report ───────────────────────────────────────────────────────
  const totalValue = toSell.reduce((s, p) => s + p.size * p.curPrice, 0);
  console.log(`Found ${toSell.length} position(s) to sell (DB-filtered):\n`);
  for (const p of toSell) {
    console.log(`  ${p.slug.padEnd(45)} ${String(p.size).padEnd(12)} @ ${p.curPrice}  ≈ $${(p.size * p.curPrice).toFixed(4)}`);
  }
  console.log(`  ${"─".repeat(72)}`);
  console.log(`  ${"TOTAL".padEnd(57)} ≈ $${totalValue.toFixed(4)}\n`);

  if (DRY_RUN) {
    console.log("Dry run complete — rerun without --dry-run to execute.");
    return;
  }

  // ── Step 4: ensure ERC-1155 approvals ───────────────────────────────────
  console.log("Checking ERC-1155 approvals...");
  await ensureCtfApprovals(wallet, provider);
  console.log();

  // ── Step 5: sell each position ───────────────────────────────────────────
  let totalReceived = 0;
  const results: Array<{ slug: string; status: string; received: number; tx?: string }> = [];

  for (const p of toSell) {
    process.stdout.write(`→ [${p.slug}]  ${p.size} shares ... `);
    try {
      const [tickSize, negRisk, book] = await Promise.all([
        client.getTickSize(p.asset),
        client.getNegRisk(p.asset),
        client.getOrderBook(p.asset),
      ]);

      const bid = bestBid(book.bids ?? []);
      if (bid === 0) {
        console.log("SKIP (no bids in order book)");
        results.push({ slug: p.slug, status: "no-bids", received: 0 });
        continue;
      }

      const resp = await client.createAndPostMarketOrder(
        { tokenID: p.asset, amount: p.size, side: Side.SELL, orderType: OrderType.FOK },
        { tickSize, negRisk },
        OrderType.FOK
      ) as any;

      if (resp?.success || resp?.status === "matched" || resp?.orderID) {
        const received = Number(resp.takingAmount ?? 0);
        totalReceived += received;
        const tx = resp.transactionsHashes?.[0] ?? resp.orderID ?? "";
        console.log(`✓  $${received}  tx: ${tx.slice(0, 16)}`);
        results.push({ slug: p.slug, status: "sold", received, tx });
      } else {
        console.log(`FAILED  ${JSON.stringify(resp).slice(0, 120)}`);
        results.push({ slug: p.slug, status: "failed", received: 0 });
      }
    } catch (e: any) {
      console.log(`ERROR  ${e?.message?.slice(0, 100) ?? e}`);
      results.push({ slug: p.slug, status: "error", received: 0 });
    }

    // Brief pause between orders to avoid nonce collisions
    await new Promise((r) => setTimeout(r, 1500));
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const sold = results.filter((r) => r.status === "sold").length;
  const failed = results.filter((r) => r.status !== "sold").length;
  console.log(`\n${"═".repeat(50)}`);
  console.log(`Sold: ${sold}/${toSell.length}   Failed/skipped: ${failed}`);
  console.log(`USDC.e recovered: $${totalReceived.toFixed(4)}`);
  console.log(`${"═".repeat(50)}`);
}

main().catch((e) => {
  console.error("\nFatal:", e?.message ?? e);
  process.exit(1);
});
