/**
 * sell-one.ts — Emergency one-off sell for a single position (no DB required).
 *
 * Use this when the DB is gone and you need to liquidate a specific token.
 *
 * Modes:
 *   npx tsx tools/sell-one.ts --list            list all live wallet positions + token IDs
 *   npx tsx tools/sell-one.ts --dry-run         preview the sell without placing any order
 *   npx tsx tools/sell-one.ts                   execute the sell for TOKEN_ID below
 *
 * MINIMUM REQUIRED: only WALLET_PRIVATE_KEY (and optionally ALCHEMY_API_KEY).
 * Polymarket API credentials are auto-derived from your wallet key if not supplied.
 *
 * STEP 1 ─ Set WALLET_PRIVATE_KEY below (or in .env).
 * STEP 2 ─ Run --list to find your TOKEN_ID, then paste it below.
 * STEP 3 ─ Run: npx tsx tools/sell-one.ts --dry-run   (verify first!)
 * STEP 4 ─ Run: npx tsx tools/sell-one.ts             (real sell)
 */

import "dotenv/config";
import { Wallet, providers, Contract, utils, BigNumber } from "ethers";
import { ClobClient, Chain, SignatureType, Side, OrderType } from "@polymarket/clob-client";

// ═══════════════════════════════════════════════════════════════════
//  CREDENTIALS — only WALLET_PRIVATE_KEY is required.
//  API_KEY / SECRET / PASSPHRASE are derived automatically from your
//  wallet key if absent — they are NOT separate secrets, kupo!
//  Never commit real values into this file.
// ═══════════════════════════════════════════════════════════════════

const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY
  ?? "0xYOUR_PRIVATE_KEY_HERE"; // TODO: only thing you must fill in

// Leave blank → EOA (direct wallet) signing
// Fill in your Polymarket proxy/funder address → POLY_PROXY signing
// Find it at: https://polymarket.com → Profile → Settings → Wallet address shown in UI
const PROXY_WALLET_ADDRESS = process.env.PROXY_WALLET_ADDRESS ?? "";

// Optional — if blank the script auto-derives them from your private key (takes ~2 sec)
const API_KEY        = process.env.API_KEY        ?? "";
const API_SECRET     = process.env.API_SECRET     ?? "";
const API_PASSPHRASE = process.env.API_PASSPHRASE ?? "";

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY ?? ""; // optional but speeds up RPC

// ═══════════════════════════════════════════════════════════════════
//  TARGET — the ERC-1155 token (asset) ID you want to sell
//
//  How to get it:
//    Option A: run   npx tsx tools/sell-one.ts --list
//    Option B: on PolygonScan open your tx → "ERC-1155 Tokens Transferred"
//              → click the Token ID number → copy it from the URL / detail page
//    Option C: https://data-api.polymarket.com/positions?user=YOUR_WALLET_ADDRESS
// ═══════════════════════════════════════════════════════════════════

const TOKEN_ID = ""; // TODO: paste the full decimal token ID (run --list to find it)

// ═══════════════════════════════════════════════════════════════════
//  ADVANCED — usually no need to change these
// ═══════════════════════════════════════════════════════════════════

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN     = Chain.POLYGON;
// Auto-detected: POLY_PROXY (1) if PROXY_WALLET_ADDRESS is set, EOA (0) if not
const SIG_TYPE  = PROXY_WALLET_ADDRESS ? SignatureType.POLY_PROXY : SignatureType.EOA;

// ── Polymarket contract addresses ─────────────────────────────────
const CTF_TOKEN        = utils.getAddress("0x4d97dcd97ec945f40cf65f87097ace5ea0476045");
const CTF_EXCHANGE     = utils.getAddress("0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e");
const NEG_RISK_EXCHANGE = utils.getAddress("0xc5d563a36ae78145c45a50134d48a1215220f80a");
const NEG_RISK_ADAPTER  = utils.getAddress("0xd91e80cf2e7be2e162c6513ced06f1dd0da35296");

const ERC1155_ABI = [
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
];

// ── Parse flags ────────────────────────────────────────────────────
const DRY_RUN  = process.argv.includes("--dry-run");
const LIST_ALL = process.argv.includes("--list");

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════

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
    ["CTF Exchange",     CTF_EXCHANGE],
    ["NegRisk Exchange", NEG_RISK_EXCHANGE],
    ["NegRisk Adapter",  NEG_RISK_ADAPTER],
  ] as [string, string][]) {
    const approved: boolean = await (ctf as any).isApprovedForAll(owner, operator);
    if (!approved) {
      if (DRY_RUN) { console.log(`  [dry-run] would setApprovalForAll → ${label}`); continue; }
      process.stdout.write(`  setApprovalForAll → ${label} ... `);
      const tx: any = await (ctf as any).setApprovalForAll(operator, true, gas);
      await tx.wait();
      console.log("done");
    }
  }
}

function bestBid(bids: Array<{ price: string; size: string }>): number {
  return bids.length === 0 ? 0 : Math.max(...bids.map((b) => Number(b.price)));
}

interface LivePosition {
  asset: string;
  size: number;
  curPrice: number;
  title: string;
  slug: string;
  negativeRisk: boolean;
}

async function fetchLivePositions(walletAddress: string): Promise<LivePosition[]> {
  const resp = await fetch(
    `https://data-api.polymarket.com/positions?user=${walletAddress}&limit=100`
  );
  if (!resp.ok) throw new Error(`Positions API returned ${resp.status}`);
  return resp.json() as Promise<LivePosition[]>;
}

// ══════════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  // ── Guard: refuse to run with placeholder values ───────────────
  if (!LIST_ALL) {
    if (WALLET_PRIVATE_KEY.includes("YOUR_PRIVATE_KEY"))
      throw new Error("Fill in WALLET_PRIVATE_KEY first (see STEP 1 above).");
    if (TOKEN_ID === "YOUR_FULL_TOKEN_ID_HERE")
      throw new Error("Fill in TOKEN_ID first (see STEP 2 above), or run with --list to discover it.");
  } else {
    if (WALLET_PRIVATE_KEY.includes("YOUR_PRIVATE_KEY"))
      throw new Error("Fill in WALLET_PRIVATE_KEY first so we know which wallet to query.");
  }

  if (DRY_RUN) console.log("── DRY RUN — no orders will be placed ──\n");

  // ── Build wallet + provider ────────────────────────────────────
  const pk = WALLET_PRIVATE_KEY.startsWith("0x") ? WALLET_PRIVATE_KEY : "0x" + WALLET_PRIVATE_KEY;
  const provider = new providers.JsonRpcProvider(
    ALCHEMY_API_KEY
      ? `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`
      : "https://polygon-rpc.com"
  );
  const wallet = new Wallet(pk);
  const funder = PROXY_WALLET_ADDRESS.trim() || undefined;

  console.log(`Wallet address : ${wallet.address}`);
  if (funder) console.log(`Proxy wallet   : ${funder}`);
  console.log();

  // ── Build CLOB client (auto-derive creds if not supplied) ───────
  let apiKey = API_KEY, apiSecret = API_SECRET, apiPassphrase = API_PASSPHRASE;
  if (!apiKey || !apiSecret || !apiPassphrase) {
    console.log("No API credentials supplied — deriving from wallet key (this is safe and deterministic)...");
    const tempClient = new ClobClient(CLOB_HOST, CHAIN, wallet, undefined, SIG_TYPE, funder);
    const derived = await tempClient.createOrDeriveApiKey();
    apiKey = derived.key;
    apiSecret = derived.secret;
    apiPassphrase = derived.passphrase;
    console.log(`API credentials derived successfully (key: ${apiKey.slice(0, 8)}...)\n`);
  }

  const client = new ClobClient(
    CLOB_HOST, CHAIN, wallet,
    { key: apiKey, secret: apiSecret, passphrase: apiPassphrase },
    SIG_TYPE, funder
  );

  // ── --list mode ────────────────────────────────────────────────
  if (LIST_ALL) {
    const positions = await fetchLivePositions(wallet.address);
    const live = positions.filter((p) => p.size > 0);
    if (live.length === 0) {
      console.log("No open positions found for this wallet.");
      return;
    }
    console.log(`Found ${live.length} open position(s):\n`);
    console.log("  TOKEN_ID (asset)".padEnd(68) + "SIZE".padEnd(14) + "PRICE".padEnd(10) + "VALUE   SLUG");
    console.log("  " + "─".repeat(110));
    for (const p of live) {
      console.log(
        `  ${p.asset.padEnd(66)}  ${String(p.size).padEnd(12)}  ${String(p.curPrice).padEnd(8)}  $${(p.size * p.curPrice).toFixed(4).padEnd(10)} ${p.slug}`
      );
    }
    console.log("\nCopy the TOKEN_ID of the position you want to sell and paste it into TOKEN_ID above.");
    return;
  }

  // ── Get live size from Polymarket ──────────────────────────────
  console.log(`Looking up live position for token: ${TOKEN_ID}\n`);
  const positions = await fetchLivePositions(wallet.address);
  const position = positions.find((p) => p.asset === TOKEN_ID);

  if (!position || position.size <= 0) {
    console.log("No live balance found for this token ID in your wallet.");
    console.log("Double-check the TOKEN_ID, or run --list to see what you actually hold.");
    return;
  }

  const { size, curPrice, slug, negativeRisk } = position;
  const estimatedValue = size * curPrice;
  console.log(`Market : ${slug}`);
  console.log(`Shares : ${size}`);
  console.log(`Price  : ${curPrice}  (~$${estimatedValue.toFixed(4)})\n`);

  // ── Get order-book best bid ────────────────────────────────────
  const [tickSize, negRisk, book] = await Promise.all([
    client.getTickSize(TOKEN_ID),
    client.getNegRisk(TOKEN_ID),
    client.getOrderBook(TOKEN_ID),
  ]);

  const bid = bestBid((book as any).bids ?? []);
  if (bid === 0) {
    console.log("No bids in order book right now — cannot sell at market. Try again later.");
    return;
  }
  console.log(`Best bid in order book: ${bid}`);
  console.log(`Expected proceeds     : ~$${(size * bid).toFixed(4)}\n`);

  if (DRY_RUN) {
    console.log("Dry run complete — rerun without --dry-run to execute the sell.");
    return;
  }

  // ── Ensure ERC-1155 approvals ──────────────────────────────────
  console.log("Checking ERC-1155 approvals...");
  await ensureCtfApprovals(wallet, provider);
  console.log();

  // ── Place the sell order ───────────────────────────────────────
  console.log(`Placing FOK market-sell: ${size} shares of [${slug}] ...`);
  const resp = await client.createAndPostMarketOrder(
    { tokenID: TOKEN_ID, amount: size, side: Side.SELL, orderType: OrderType.FOK },
    { tickSize, negRisk },
    OrderType.FOK
  ) as any;

  if (resp?.success || resp?.status === "matched" || resp?.orderID) {
    const received = Number(resp.takingAmount ?? 0);
    const tx = resp.transactionsHashes?.[0] ?? resp.orderID ?? "(no tx hash returned)";
    console.log(`\nSUCCESS`);
    console.log(`USDC.e received : $${received}`);
    console.log(`Tx / Order ID   : ${tx}`);
  } else {
    console.error(`\nFAILED — full response:`);
    console.error(JSON.stringify(resp, null, 2));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\nFatal:", e?.message ?? e);
  process.exit(1);
});

/*
 * ── HOW TO FIND YOUR TOKEN ID ─────────────────────────────────────────────────
 *
 * Method A — easiest:
 *   npx tsx tools/sell-one.ts --list
 *   (lists every open position with full token IDs)
 *
 * Method B — PolygonScan:
 *   1. Open your transaction on https://polygonscan.com
 *   2. Scroll to "ERC-1155 Tokens Transferred"
 *   3. Click the token ID number in brackets [...]
 *   4. The full decimal token ID appears in the URL or on the token page
 *
 * Method C — Polymarket API directly:
 *   https://data-api.polymarket.com/positions?user=YOUR_WALLET_ADDRESS&limit=100
 *   Look for the "asset" field in each entry.
 *
 * ── WHAT EACH CREDENTIAL IS ───────────────────────────────────────────────────
 *
 * WALLET_PRIVATE_KEY   — your EOA private key (the one that owns the wallet)
 * PROXY_WALLET_ADDRESS — your Polymarket "funder" address shown in the app UI
 *                        (same as FUNDER_ADDRESS in your old .env). Leave "" if
 *                        you use EOA signing (SIGNATURE_TYPE=0).
 * API_KEY / SECRET / PASSPHRASE — Polymarket CLOB API credentials.
 *   If you no longer have these, delete API_KEY from .env — the client will
 *   automatically derive fresh credentials from your wallet on first run.
 */
