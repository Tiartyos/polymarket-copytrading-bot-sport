/**
 * redeem-all.ts — Redeem ALL resolved Polymarket positions at once.
 *
 * Fetches every open token position in your wallet, identifies which ones have
 * resolved on-chain (payoutDenominator > 0), then calls CTF.redeemPositions
 * for each resolved winner.
 *
 * NegRisk markets are skipped with a warning — redeem those at polymarket.com.
 *
 * Usage:
 *   npm run redeem-all
 *   npm run redeem-all -- --dry-run   (print what would be redeemed, no tx sent)
 *
 * All credentials come from .env — nothing sensitive is in this file.
 */
import "dotenv/config";
import { Wallet, providers, Contract, utils, BigNumber, constants } from "ethers";
import { loadConfig } from "../src/config";

// ── Contract addresses (Polygon Mainnet) ──────────────────────────────────────
const CTF_ADDR  = utils.getAddress("0x4d97dcd97ec945f40cf65f87097ace5ea0476045");
const USDC_ADDR = utils.getAddress("0x2791bca1f2de4661ed88a30c99a7a9449aa84174");

const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
  "function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
];

const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const PROXY_ABI = [
  "function execute(address to, bytes calldata data) external payable returns (bool success, bytes memory returnData)",
];

const DRY_RUN = process.argv.includes("--dry-run");

// ── Gamma API types ───────────────────────────────────────────────────────────
interface GammaToken { token_id: string; outcome: string; winner?: boolean }
interface GammaMarket {
  conditionId: string;
  slug?: string; question?: string;
  negRisk?: boolean; negativeRisk?: boolean;
  tokens?: GammaToken[];
  clobTokenIds?: string[] | string;
  outcomes?: string[] | string;
}

function parseStringOrArray(val: string[] | string | undefined): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val) as string[]; } catch { return []; }
}

async function fetchGammaMarket(tokenId: string): Promise<GammaMarket | null> {
  try {
    const resp = await fetch(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}&limit=1`);
    if (!resp.ok) return null;
    const raw = await resp.json();
    const markets = (Array.isArray(raw) ? raw : [raw]) as GammaMarket[];
    if (!markets?.length) return null;
    const m = markets[0];
    (m as any)._tokenIds = parseStringOrArray(m.clobTokenIds);
    (m as any)._outcomes = parseStringOrArray(m.outcomes);
    return m;
  } catch { return null; }
}

async function getGasOverrides(provider: providers.JsonRpcProvider): Promise<Record<string, BigNumber>> {
  const feeData = await provider.getFeeData();
  const MIN_PRIORITY = BigNumber.from("30000000000"); // 30 gwei — Polygon minimum
  const priority = (feeData.maxPriorityFeePerGas ?? BigNumber.from(0)).gt(MIN_PRIORITY)
    ? feeData.maxPriorityFeePerGas!
    : MIN_PRIORITY;
  const gas: Record<string, BigNumber> = { maxPriorityFeePerGas: priority };
  if (feeData.maxFeePerGas) gas.maxFeePerGas = feeData.maxFeePerGas.add(priority);
  return gas;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (DRY_RUN) console.log("── DRY RUN — no transactions will be submitted ──\n");

  const config = loadConfig();
  const { walletPrivateKey, proxyWalletAddress } = config;
  const pk = walletPrivateKey.startsWith("0x") ? walletPrivateKey : "0x" + walletPrivateKey;

  const provider = new providers.JsonRpcProvider(
    process.env.ALCHEMY_API_KEY
      ? `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
      : "https://polygon-rpc.com"
  );
  const wallet = new Wallet(pk, provider);

  const rawProxy = (proxyWalletAddress || "").trim();
  const proxyAddr = rawProxy && rawProxy.toLowerCase() !== wallet.address.toLowerCase() ? rawProxy : "";

  console.log(`EOA wallet    : ${wallet.address}`);
  if (proxyAddr) console.log(`Proxy wallet  : ${proxyAddr}`);
  console.log();

  // ── Step 1: fetch live positions ─────────────────────────────────────────
  console.log("Fetching live positions from Polymarket...");
  const posResp = await fetch(`https://data-api.polymarket.com/positions?user=${wallet.address}&limit=100`);
  if (!posResp.ok) throw new Error(`Positions API returned ${posResp.status}`);

  const livePositions = (await posResp.json()) as Array<{
    asset: string; size: number; curPrice: number;
    title: string; slug: string; negativeRisk: boolean;
  }>;

  const candidates = livePositions.filter(p => p.size > 0);
  if (candidates.length === 0) {
    console.log("No open positions found.");
    return;
  }
  console.log(`Found ${candidates.length} open position(s). Checking for resolved markets...\n`);

  // ── Step 2: collect redeemable tasks ─────────────────────────────────────
  const ctf  = new Contract(CTF_ADDR, CTF_ABI, provider);
  const usdc = new Contract(USDC_ADDR, USDC_ABI, provider);
  const decimals = Number(await usdc.decimals());

  interface RedeemTask {
    asset: string; slug: string;
    conditionId: string; indexSet: number; outcomeLabel: string;
    holderAddr: string; holderLabel: "EOA" | "proxy"; holdingBal: BigNumber;
  }

  const tasks: RedeemTask[] = [];
  const skipped: string[] = [];

  for (const p of candidates) {
    const label = (p.slug ?? p.asset.slice(0, 16)).padEnd(48);
    process.stdout.write(`  Checking ${label} `);

    if (p.negativeRisk) {
      console.log("SKIP (NegRisk — redeem at polymarket.com)");
      skipped.push(`${p.slug} (NegRisk)`);
      continue;
    }

    const market = await fetchGammaMarket(p.asset);
    if (!market) {
      console.log("SKIP (could not fetch market from Gamma API)");
      skipped.push(`${p.asset.slice(0, 12)} (no Gamma data)`);
      continue;
    }
    if (market.negRisk || market.negativeRisk) {
      console.log("SKIP (NegRisk — redeem at polymarket.com)");
      skipped.push(`${p.slug} (NegRisk)`);
      continue;
    }

    const conditionId = market.conditionId;
    const denom: BigNumber = await ctf.payoutDenominator(conditionId);
    if (denom.isZero()) {
      console.log("not resolved yet");
      continue;
    }

    // Determine token index → indexSet bitmask
    const m = market as any;
    const tokenIds: string[] = market.tokens?.map(t => t.token_id) ?? (m._tokenIds as string[]) ?? [];
    const outcomes: string[] = market.tokens?.map(t => t.outcome) ?? (m._outcomes as string[]) ?? [];
    const winners: (boolean | undefined)[] = market.tokens?.map(t => t.winner) ?? new Array(tokenIds.length).fill(undefined);

    let tokenIndex = tokenIds.findIndex(id => id === p.asset);
    if (tokenIndex === -1) {
      const [n0, n1]: BigNumber[] = await Promise.all([
        ctf.payoutNumerators(conditionId, 0),
        ctf.payoutNumerators(conditionId, 1),
      ]);
      tokenIndex = n1.gt(n0) ? 1 : 0;
    }

    const indexSet     = 1 << tokenIndex;
    const outcomeLabel = outcomes[tokenIndex] ?? `outcome[${tokenIndex}]`;
    const winner       = winners[tokenIndex];

    // Determine token holder (EOA or proxy)
    const tokenIdBn = BigNumber.from(p.asset);
    const eoaBalance: BigNumber   = await ctf.balanceOf(wallet.address, tokenIdBn);
    const proxyBalance: BigNumber = proxyAddr
      ? await ctf.balanceOf(proxyAddr, tokenIdBn)
      : BigNumber.from(0);

    const useProxy = eoaBalance.isZero() && proxyBalance.gt(0);
    const useEoa   = eoaBalance.gt(0);

    if (!useEoa && !useProxy) {
      console.log("SKIP (no token balance found)");
      skipped.push(`${p.slug} (no balance)`);
      continue;
    }

    const holderAddr  = useProxy ? proxyAddr  : wallet.address;
    const holderLabel = (useProxy ? "proxy" : "EOA") as "EOA" | "proxy";
    const holdingBal  = useProxy ? proxyBalance : eoaBalance;
    const winStr      = winner === true ? " ✓ WIN" : winner === false ? " ✗ LOSS" : "";

    console.log(`RESOLVED  ${outcomeLabel}${winStr}  (${holdingBal.toString()} shares via ${holderLabel})`);
    tasks.push({ asset: p.asset, slug: p.slug, conditionId, indexSet, outcomeLabel, holderAddr, holderLabel, holdingBal });
  }

  console.log();

  if (tasks.length === 0) {
    console.log("No redeemable positions found.");
    if (skipped.length) console.log(`Skipped (${skipped.length}): ${skipped.join(", ")}`);
    return;
  }

  // ── Step 3: summary ──────────────────────────────────────────────────────
  const estTotal = tasks.reduce((s, t) => s + Number(t.holdingBal.toString()) / 1e6, 0);
  console.log(`Redeemable positions: ${tasks.length}\n`);
  for (const t of tasks) {
    const est = (Number(t.holdingBal.toString()) / 1e6).toFixed(4);
    console.log(`  ${t.slug.padEnd(45)} ${t.outcomeLabel.padEnd(10)} ≈ $${est}  [${t.holderLabel}]`);
  }
  console.log(`  ${"─".repeat(68)}`);
  console.log(`  ${"TOTAL".padEnd(57)} ≈ $${estTotal.toFixed(4)}\n`);

  if (DRY_RUN) {
    console.log("Dry run complete — rerun without --dry-run to execute.");
    if (skipped.length) console.log(`Skipped (${skipped.length}): ${skipped.join(", ")}`);
    return;
  }

  // ── Step 4: redeem each position ─────────────────────────────────────────
  const ctfInterface = new utils.Interface(CTF_ABI);
  const gasOverrides = await getGasOverrides(provider);
  const usdcBefore: BigNumber = await usdc.balanceOf(wallet.address);

  const results: Array<{ slug: string; status: string; tx?: string }> = [];

  for (const t of tasks) {
    process.stdout.write(`→ [${t.slug}]  ${t.outcomeLabel} (${t.holdingBal.toString()} shares) ... `);
    try {
      let txHash: string;
      let receipt: providers.TransactionReceipt;

      if (t.holderLabel === "EOA") {
        const ctfSigned = ctf.connect(wallet);
        const tx = await (ctfSigned as any).redeemPositions(
          USDC_ADDR, constants.HashZero, t.conditionId, [t.indexSet], gasOverrides
        );
        process.stdout.write(`tx ${tx.hash.slice(0, 14)} ... `);
        receipt = await tx.wait();
        txHash  = tx.hash;
      } else {
        const redeemData = ctfInterface.encodeFunctionData("redeemPositions", [
          USDC_ADDR, constants.HashZero, t.conditionId, [t.indexSet],
        ]);
        const proxy = new Contract(t.holderAddr, PROXY_ABI, wallet);
        const tx = await proxy.execute(CTF_ADDR, redeemData, { ...gasOverrides, value: 0 });
        process.stdout.write(`tx ${tx.hash.slice(0, 14)} ... `);
        receipt = await tx.wait();
        txHash  = tx.hash;
      }

      console.log(`✓  block ${receipt.blockNumber}`);
      results.push({ slug: t.slug, status: "redeemed", tx: txHash });
    } catch (e: any) {
      console.log(`ERROR  ${e?.message?.slice(0, 100) ?? e}`);
      results.push({ slug: t.slug, status: "error" });
    }

    // Brief pause between txs to avoid nonce collisions
    await new Promise(r => setTimeout(r, 1500));
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const usdcAfter: BigNumber = await usdc.balanceOf(wallet.address);
  const netReceived = Number(usdcAfter.sub(usdcBefore).toString()) / 10 ** decimals;
  const redeemed = results.filter(r => r.status === "redeemed").length;
  const failed   = results.filter(r => r.status !== "redeemed").length;

  console.log(`\n${"═".repeat(52)}`);
  console.log(`Redeemed: ${redeemed}/${tasks.length}   Failed: ${failed}`);
  console.log(`USDC.e recovered : $${netReceived.toFixed(4)} (EOA wallet net delta)`);
  if (proxyAddr) console.log(`Note: proxy wallet redemptions not included in EOA delta above`);
  console.log(`${"═".repeat(52)}`);
  if (skipped.length) console.log(`\nSkipped (${skipped.length}): ${skipped.join(", ")}`);
}

main().catch((e) => {
  console.error("\nFatal:", e?.message ?? e);
  process.exit(1);
});
