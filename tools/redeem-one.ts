/**
 * redeem-one.ts — Redeem a RESOLVED Polymarket position directly on-chain.
 *
 * Use this when:
 *   • The market has already resolved (token price = $1.00 / $0.00)
 *   • The CLOB order book is closed ("No orderbook exists" error on sell)
 *   • You want USDC.e back WITHOUT using the Polymarket web UI
 *
 * Modes:
 *   npx tsx tools/redeem-one.ts --dry-run    preview without submitting any tx
 *   npx tsx tools/redeem-one.ts              execute on-chain redemption
 *
 * MINIMUM REQUIRED: WALLET_PRIVATE_KEY only.
 * Polymarket credentials are NOT needed — this is a direct contract call.
 *
 * STEP 1 — set WALLET_PRIVATE_KEY in .env (already done if you ran sell-one)
 * STEP 2 — paste your winning TOKEN_ID below (from the --list output)
 * STEP 3 — run: npx tsx tools/redeem-one.ts --dry-run
 * STEP 4 — run: npx tsx tools/redeem-one.ts
 *
 * ── About proxy wallets ────────────────────────────────────────────────────
 * If Polymarket deposited your outcome tokens into a proxy wallet (not your
 * EOA directly), this script auto-detects that and calls through the proxy.
 * You can set PROXY_WALLET_ADDRESS in .env, OR the script will look it up
 * on-chain by checking token balances.
 * ──────────────────────────────────────────────────────────────────────────
 */

import "dotenv/config";
import { Wallet, providers, Contract, utils, BigNumber, constants } from "ethers";

// ═══════════════════════════════════════════════════════════════════
//  CREDENTIALS
//  Only WALLET_PRIVATE_KEY is mandatory — no Polymarket API keys needed.
// ═══════════════════════════════════════════════════════════════════

const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY
  ?? "0xYOUR_PRIVATE_KEY_HERE"; // TODO: only thing you MUST fill in

// Your Polymarket proxy / funder wallet address (the smart-contract wallet).
// Leave blank → script will auto-detect from on-chain token balance check.
// Find it on PolygonScan: open your BUY transaction → ERC-1155 Tokens
// Transferred → the "To" address that received the tokens is your proxy.
const PROXY_WALLET_ADDRESS = process.env.PROXY_WALLET_ADDRESS ?? "";

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY ?? "";

// ═══════════════════════════════════════════════════════════════════
//  TARGET — the ERC-1155 token ID of your WINNING position
//  (the one sitting at price = $1.00 from --list)
// ═══════════════════════════════════════════════════════════════════

const TOKEN_ID = ""; // TODO: paste decimal token ID

// ═══════════════════════════════════════════════════════════════════
//  OPTIONAL OVERRIDE — if Gamma API is unreachable, paste the conditionId
//  here (32-byte hex, 0x-prefixed). Leave "" to auto-fetch from Gamma API.
//  Find it at: https://gamma-api.polymarket.com/markets?clob_token_ids=TOKEN_ID
// ═══════════════════════════════════════════════════════════════════

const CONDITION_ID_OVERRIDE = "";

// ══════════════════════════════════════════════════════════════════
//  CONTRACT ADDRESSES (Polygon Mainnet) — do not change
// ══════════════════════════════════════════════════════════════════

// Gnosis Conditional Token Framework — holds all outcome tokens + redeems
const CTF_ADDR  = utils.getAddress("0x4d97dcd97ec945f40cf65f87097ace5ea0476045");
// USDC.e (bridged USDC) — Polymarket's collateral token
const USDC_ADDR = utils.getAddress("0x2791bca1f2de4661ed88a30c99a7a9449aa84174");

// ── ABIs ──────────────────────────────────────────────────────────

const CTF_ABI = [
  // Redeem resolved outcome tokens for collateral
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external",
  // Non-zero denominator confirms the market is resolved on-chain
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
  // payoutNumerators(conditionId, outcomeIndex) — used to determine winning slot on-chain
  "function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)",
  // Check who actually holds the ERC-1155 tokens
  "function balanceOf(address account, uint256 id) view returns (uint256)",
];

const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// Polymarket proxy wallet — typical execute interface used by their forwarding wallets
const PROXY_ABI = [
  "function execute(address to, bytes calldata data) external payable returns (bool success, bytes memory returnData)",
];

// ── Flags ─────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════

interface GammaToken {
  token_id: string;
  outcome: string;
  winner?: boolean;
  price?: number;
}

interface GammaMarket {
  conditionId: string;
  slug?: string;
  question?: string;
  negRisk?: boolean;
  negativeRisk?: boolean;
  // Gamma API returns these as either real arrays OR JSON-encoded strings — we normalise below
  tokens?: GammaToken[];
  clobTokenIds?: string[] | string;
  outcomes?: string[] | string;
}

/** Parse a field that the Gamma API sometimes returns as a JSON-encoded string
 *  (e.g. `"[\"id1\",\"id2\"]"`) and sometimes as a real array. */
function parseStringOrArray(val: string[] | string | undefined): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val) as string[]; } catch { return []; }
}

async function fetchMarketFromGamma(tokenId: string): Promise<GammaMarket> {
  const url = `https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}&limit=1`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Gamma API returned ${resp.status} for token lookup`);
  const raw = await resp.json();
  const markets = (Array.isArray(raw) ? raw : [raw]) as GammaMarket[];
  if (!markets?.length) throw new Error(
    `Token not found in Gamma API.\n` +
    `  • Verify TOKEN_ID is correct\n` +
    `  • Or: set CONDITION_ID_OVERRIDE manually and re-run`
  );
  const m = markets[0];
  // Normalise: ensure clobTokenIds and outcomes are always real string arrays
  (m as any)._tokenIds  = parseStringOrArray(m.clobTokenIds);
  (m as any)._outcomes  = parseStringOrArray(m.outcomes);
  return m;
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

// ══════════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  // ── Validate inputs ───────────────────────────────────────────
  if (WALLET_PRIVATE_KEY.includes("YOUR_PRIVATE_KEY"))
    throw new Error("Set WALLET_PRIVATE_KEY in .env (or directly in the script).");
  if ((TOKEN_ID as string) === "YOUR_FULL_TOKEN_ID_HERE")
    throw new Error("Set TOKEN_ID to the decimal token ID of the winning position (run sell-one --list to find it).");

  if (DRY_RUN) console.log("── DRY RUN — no transaction will be submitted ──\n");

  // ── Set up wallet + provider ──────────────────────────────────
  const pk = WALLET_PRIVATE_KEY.startsWith("0x") ? WALLET_PRIVATE_KEY : "0x" + WALLET_PRIVATE_KEY;
  const provider = new providers.JsonRpcProvider(
    ALCHEMY_API_KEY
      ? `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`
      : "https://polygon-rpc.com"
  );
  const wallet = new Wallet(pk, provider);
  console.log(`EOA wallet     : ${wallet.address}`);
  if (PROXY_WALLET_ADDRESS) console.log(`Proxy wallet   : ${PROXY_WALLET_ADDRESS}`);
  console.log();

  // ── Resolve conditionId ───────────────────────────────────────
  let conditionId: string;
  let indexSet: number;
  let outcomeLabel: string;
  let isNegRisk = false;

  if (CONDITION_ID_OVERRIDE) {
    console.log(`Using manual conditionId override: ${CONDITION_ID_OVERRIDE}`);
    conditionId = CONDITION_ID_OVERRIDE;
    // Can't determine indexSet without market data — default to trying [1] (outcome 0 / YES)
    indexSet = 1;
    outcomeLabel = "outcome[0] / YES — if this fails, change to indexSet=2 (NO)";
  } else {
    console.log("Fetching market data from Gamma API...");
    const market = await fetchMarketFromGamma(TOKEN_ID);
    conditionId = market.conditionId;
    isNegRisk   = market.negRisk ?? market.negativeRisk ?? false;
    const slug  = market.slug ?? market.question ?? conditionId;

    console.log(`Market         : ${slug}`);
    console.log(`ConditionId    : ${conditionId}`);
    console.log(`NegRisk        : ${isNegRisk}`);

    if (isNegRisk) {
      throw new Error(
        "This is a NegRisk market — it uses a different redemption contract (NegRiskAdapter).\n" +
        "For now, please redeem at https://polymarket.com (Profile → Portfolio → Redeem).\n" +
        "If you need a script for this too, just ask, kupo!"
      );
    }

    // Find which token in this market matches our TOKEN_ID → determines indexSet
    // CTF binary markets: tokens[0] → indexSet 1 (0b01), tokens[1] → indexSet 2 (0b10)
    // Use pre-normalised arrays (_tokenIds / _outcomes) that were JSON-parsed in fetchMarketFromGamma
    const m = market as any;
    const tokenIds: string[] =
      market.tokens?.map(t => t.token_id) ??
      (m._tokenIds as string[]) ??
      [];
    const outcomes: string[] =
      market.tokens?.map(t => t.outcome) ??
      (m._outcomes as string[]) ??
      [];
    const winners: (boolean | undefined)[] =
      market.tokens?.map(t => t.winner) ??
      new Array(tokenIds.length).fill(undefined);

    let tokenIndex = tokenIds.findIndex(id => id === TOKEN_ID);

    if (tokenIndex === -1 && tokenIds.length > 0) {
      // Log what Gamma returned so we can debug further
      console.warn(`  [warn] TOKEN_ID not in Gamma token list: [${tokenIds.join(", ")}]`);
      console.warn(`  [warn] Falling back to on-chain payoutNumerators to detect winning slot...`);
    }

    if (tokenIndex === -1) {
      // On-chain fallback: for a binary market check which outcome slot was paid out.
      // We try both indexSets (1 and 2) and use the one whose payout > 0.
      // The CTF contract: indexSet is a bitmask — indexSet=1 means outcome slot 0,
      //                                             indexSet=2 means outcome slot 1.
      const ctfTemp = new Contract(CTF_ADDR, CTF_ABI, provider);
      const [n0, n1]: BigNumber[] = await Promise.all([
        ctfTemp.payoutNumerators(conditionId, 0),
        ctfTemp.payoutNumerators(conditionId, 1),
      ]);
      console.log(`  On-chain payoutNumerators: slot0=${n0.toString()}, slot1=${n1.toString()}`);
      // Pick the winning slot (numerator > 0); for a tie we default to slot 0
      const winningSlot = n1.gt(n0) ? 1 : 0;
      tokenIndex        = winningSlot;
      console.warn(`  [warn] Using on-chain winning slot ${winningSlot} → indexSet=${1 << winningSlot}`);
    }

    indexSet     = 1 << tokenIndex; // slot 0 → 1, slot 1 → 2
    outcomeLabel = outcomes[tokenIndex] ?? `outcome[${tokenIndex}]`;
    const winner = winners[tokenIndex];

    console.log(`Your outcome   : ${outcomeLabel} (indexSet=${indexSet})`);
    if (winner !== undefined) console.log(`Resolved winner: ${winner ? "YES — this is the winning token ✓" : "NO — this is the LOSING token (value = $0)"}`);
    console.log();
  }

  // ── Verify market is resolved on-chain ────────────────────────
  const ctf  = new Contract(CTF_ADDR,  CTF_ABI,  provider);
  const usdc = new Contract(USDC_ADDR, USDC_ABI, provider);

  const denom: BigNumber = await ctf.payoutDenominator(conditionId);
  if (denom.isZero()) {
    throw new Error(
      "Market is NOT resolved on-chain yet (payoutDenominator = 0).\n" +
      "Wait for Polymarket to report the result (usually within a few hours of game end)."
    );
  }
  console.log(`On-chain resolution confirmed ✓  (payoutDenominator = ${denom.toString()})`);

  // ── Detect who actually holds the ERC-1155 tokens ────────────
  // TOKEN_ID is a decimal string; the contract takes uint256
  const tokenIdBn = BigNumber.from(TOKEN_ID);

  const eoaBalance: BigNumber  = await ctf.balanceOf(wallet.address, tokenIdBn);
  // Ignore proxy address if it was accidentally set to the same value as the EOA
  const rawProxy   = PROXY_WALLET_ADDRESS.trim();
  const proxyAddr  = (rawProxy && rawProxy.toLowerCase() !== wallet.address.toLowerCase()) ? rawProxy : "";
  if (rawProxy && !proxyAddr) console.warn("  [warn] PROXY_WALLET_ADDRESS matches EOA — treating as no proxy set.");
  const proxyBalance: BigNumber = proxyAddr
    ? await ctf.balanceOf(proxyAddr, tokenIdBn)
    : BigNumber.from(0);

  console.log(`\nToken balance (EOA)  : ${eoaBalance.toString()}`);
  if (proxyAddr) console.log(`Token balance (proxy): ${proxyBalance.toString()}`);

  const useProxy = eoaBalance.isZero() && proxyBalance.gt(0);
  const useEoa   = eoaBalance.gt(0);

  if (!useEoa && !useProxy) {
    if (!proxyAddr && eoaBalance.isZero()) {
      throw new Error(
        "No tokens found in your EOA wallet.\n" +
        "Your tokens are likely in your Polymarket PROXY wallet (a smart contract).\n\n" +
        "To fix:\n" +
        "  1. Find your proxy wallet address:\n" +
        "     → Open your BUY transaction on https://polygonscan.com\n" +
        "     → Look at 'ERC-1155 Tokens Transferred'\n" +
        "     → The final 'To' address that received the tokens is your proxy wallet\n" +
        "  2. Set it in .env:  PROXY_WALLET_ADDRESS=0xYourProxyAddress\n" +
        "  3. Re-run this script."
      );
    }
    throw new Error(
      "No tokens found in EOA or proxy wallet.\n" +
      "Possible reasons: already redeemed, wrong TOKEN_ID, or wrong wallet address."
    );
  }

  const holderAddr   = useProxy ? proxyAddr  : wallet.address;
  const holderLabel  = useProxy ? "proxy"    : "EOA";
  const holdingBal   = useProxy ? proxyBalance : eoaBalance;
  console.log(`\nToken holder: ${holderLabel} (${holderAddr}) — ${holdingBal.toString()} shares`);

  // ── USDC balance before ───────────────────────────────────────
  const decimals = Number(await usdc.decimals());
  const usdcBefore: BigNumber = await usdc.balanceOf(holderAddr);
  console.log(`USDC.e before : $${(Number(usdcBefore.toString()) / 10 ** decimals).toFixed(4)}`);
  console.log();

  // ── Dry-run summary ───────────────────────────────────────────
  if (DRY_RUN) {
    console.log("Would call CTF.redeemPositions with:");
    console.log(`  collateralToken       : ${USDC_ADDR}`);
    console.log(`  parentCollectionId    : ${constants.HashZero}`);
    console.log(`  conditionId           : ${conditionId}`);
    console.log(`  indexSets             : [${indexSet}]`);
    console.log(`  caller                : ${holderLabel} (${holderAddr})`);
    if (useProxy) {
      console.log(`  via proxy.execute()   : yes (EOA signs, proxy forwards to CTF)`);
    }
    console.log(`\nEstimated payout : ~$${(Number(holdingBal.toString()) / 1e6).toFixed(4)} USDC.e`);
    console.log("\nDry run complete — rerun without --dry-run to execute.");
    return;
  }

  // ── Gas settings ──────────────────────────────────────────────
  const gasOverrides = await getGasOverrides(provider);

  // ── Build the CTF call ────────────────────────────────────────
  const ctfInterface = new utils.Interface(CTF_ABI);
  const redeemData = ctfInterface.encodeFunctionData("redeemPositions", [
    USDC_ADDR,
    constants.HashZero,
    conditionId,
    [indexSet],
  ]);

  let txHash: string;
  let receipt: providers.TransactionReceipt;

  if (useEoa) {
    // ── Direct call from EOA ──────────────────────────────────
    console.log("Submitting redeemPositions directly from EOA...");
    const ctfSigned = ctf.connect(wallet);
    const tx = await ctfSigned.redeemPositions(
      USDC_ADDR,
      constants.HashZero,
      conditionId,
      [indexSet],
      gasOverrides
    );
    console.log(`Tx submitted : ${tx.hash}`);
    process.stdout.write("Waiting for confirmation...");
    receipt  = await tx.wait();
    txHash   = tx.hash;

  } else {
    // ── Call through proxy wallet ─────────────────────────────
    // The proxy's execute(address,bytes) forwards the call as if proxy is msg.sender,
    // so CTF sees the proxy wallet as the caller and redeems its tokens.
    console.log("Submitting redeemPositions through proxy wallet...");
    const proxy = new Contract(proxyAddr, PROXY_ABI, wallet);
    const tx = await proxy.execute(CTF_ADDR, redeemData, { ...gasOverrides, value: 0 });
    console.log(`Tx submitted : ${tx.hash}`);
    process.stdout.write("Waiting for confirmation...");
    receipt = await tx.wait();
    txHash  = tx.hash;
  }

  console.log(` confirmed in block ${receipt.blockNumber} ✓`);

  // ── USDC balance after ────────────────────────────────────────
  const usdcAfter: BigNumber = await usdc.balanceOf(holderAddr);
  const received = Number(usdcAfter.sub(usdcBefore).toString()) / 10 ** decimals;
  const totalAfter = Number(usdcAfter.toString()) / 10 ** decimals;

  console.log(`\n${"═".repeat(52)}`);
  console.log(`USDC.e received : $${received.toFixed(4)}`);
  console.log(`USDC.e balance  : $${totalAfter.toFixed(4)}`);
  console.log(`PolygonScan     : https://polygonscan.com/tx/${txHash}`);
  console.log(`${"═".repeat(52)}`);
}

main().catch(e => {
  console.error("\nFatal:", e?.message ?? e);
  process.exit(1);
});

/*
 * ── TROUBLESHOOTING ────────────────────────────────────────────────────────────
 *
 * "No tokens found in your EOA wallet"
 *   → Your tokens are in your Polymarket PROXY wallet (smart contract).
 *     Find the proxy address on PolygonScan (open your BUY tx, look at
 *     "ERC-1155 Tokens Transferred", the final recipient is the proxy).
 *     Set PROXY_WALLET_ADDRESS=0x... in .env and retry.
 *
 * "execution reverted" on the proxy.execute() call
 *   → The proxy wallet contract may use a different execute interface.
 *     Try the Polymarket UI (polymarket.com → Portfolio → Redeem) as a
 *     fallback — it handles all proxy types automatically.
 *
 * "Market is NOT resolved on-chain yet"
 *   → Polymarket hasn't submitted the resolution tx yet. This usually
 *     happens within 1-3 hours after game end. Try again later, kupo!
 *
 * "token_id not found in Gamma API market"
 *   → Double-check you copied the full decimal TOKEN_ID from the --list
 *     output. The number is ~77 digits long.
 *
 * conditionId manual lookup:
 *   Open in browser: https://gamma-api.polymarket.com/markets?clob_token_ids=YOUR_TOKEN_ID
 *   Copy the "conditionId" field and paste it into CONDITION_ID_OVERRIDE above.
 */
