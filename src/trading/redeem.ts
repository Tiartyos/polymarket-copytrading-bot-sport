/**
 * Auto-redeem a resolved Polymarket position on-chain.
 *
 * Called when the leader exits a position from a market that has already
 * resolved (endDate is past) and we hold the corresponding winning token.
 * CLOB orders cannot be placed on resolved markets, so we call CTF directly.
 *
 * Supports both EOA and proxy (Magic / smart-contract) wallets — same
 * detection logic used by tools/redeem-one.ts.
 */
import { Wallet, providers, Contract, constants, utils, BigNumber } from "ethers";
import type { LeaderTrade, AppConfig } from "../types";
import { insertCopiedTrade, updateTradeStatus } from "../db/queries";

// ── Polygon contract addresses (do not change) ─────────────────────────────
const CTF_ADDR  = utils.getAddress("0x4d97dcd97ec945f40cf65f87097ace5ea0476045");
const USDC_ADDR = utils.getAddress("0x2791bca1f2de4661ed88a30c99a7a9449aa84174");

const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
  "function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
];

const PROXY_ABI = [
  "function execute(address to, bytes calldata data) external payable returns (bool success, bytes memory returnData)",
];

// ── Helpers ─────────────────────────────────────────────────────────────────

interface GammaToken { token_id: string; outcome?: string; }
interface GammaMarket {
  conditionId: string;
  negRisk?: boolean;
  negativeRisk?: boolean;
  tokens?: GammaToken[];
  clobTokenIds?: string[] | string;
  outcomes?: string[] | string;
}

function parseStringOrArray(val: string[] | string | undefined): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val) as string[]; } catch { return []; }
}

/**
 * Determine the CTF indexSet for the given token.
 * Tries Gamma API first; falls back to on-chain payoutNumerators.
 * Throws for NegRisk markets (different redemption contract).
 */
async function resolveIndexSet(ctf: Contract, tokenId: string, conditionId: string): Promise<number> {
  const url = `https://gamma-api.polymarket.com/markets?clob_token_ids=${encodeURIComponent(tokenId)}&limit=1`;
  try {
    const resp = await fetch(url);
    if (resp.ok) {
      const raw = await resp.json();
      const markets = (Array.isArray(raw) ? raw : [raw]) as GammaMarket[];
      if (markets.length > 0) {
        const m = markets[0];
        if (m.negRisk ?? m.negativeRisk) {
          throw new Error("NegRisk market — please redeem manually at https://polymarket.com");
        }
        const tokenIds: string[] = m.tokens?.map(t => t.token_id) ?? parseStringOrArray(m.clobTokenIds);
        const idx = tokenIds.findIndex(id => id === tokenId);
        if (idx !== -1) return 1 << idx; // slot 0 → 1, slot 1 → 2
      }
    }
  } catch (e: any) {
    if ((e.message as string).includes("NegRisk")) throw e;
    // Gamma API unavailable — fall through to on-chain detection
  }

  // On-chain fallback: pick the slot whose payout numerator is > 0
  const [n0, n1]: BigNumber[] = await Promise.all([
    ctf.payoutNumerators(conditionId, 0),
    ctf.payoutNumerators(conditionId, 1),
  ]);
  return 1 << (n1.gt(n0) ? 1 : 0);
}

const POLYGON_RPC =
  process.env.POLYGON_RPC?.trim() ??
  (process.env.ALCHEMY_API_KEY?.trim()
    ? `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
    : "https://polygon-rpc.com");

// ── Main exported function ──────────────────────────────────────────────────

/**
 * Redeem the bot's own holding of a resolved outcome token on-chain.
 *
 * @param trade         The REDEEM trade emitted by the polling loop
 *                      (trade.market = conditionId, trade.asset_id = token ID).
 * @param config        Full app config (provides walletPrivateKey + proxyWalletAddress).
 * @param leaderAddress Leader wallet that triggered the redeem — stored in DB for audit.
 */
export async function redeemBotPosition(
  trade: LeaderTrade,
  config: AppConfig,
  leaderAddress: string
): Promise<void> {
  const { asset_id, market: conditionId } = trade;
  const pk = config.walletPrivateKey.startsWith("0x")
    ? config.walletPrivateKey
    : "0x" + config.walletPrivateKey;

  // Persist intent before any network calls
  insertCopiedTrade(trade.id, leaderAddress, trade, "0");

  const provider = new providers.JsonRpcProvider(POLYGON_RPC);
  const wallet   = new Wallet(pk, provider);
  const ctf      = new Contract(CTF_ADDR, CTF_ABI, provider);

  // ── Verify market is resolved on-chain ─────────────────────────────────
  const denom: BigNumber = await ctf.payoutDenominator(conditionId);
  if (denom.isZero()) {
    console.log(`[REDEEM] Market ${conditionId.slice(0, 10)}… not yet resolved on-chain — skipping`);
    updateTradeStatus(trade.id, "FAILED");
    return;
  }

  // ── Determine which indexSet to pass to redeemPositions ────────────────
  let indexSet: number;
  try {
    indexSet = await resolveIndexSet(ctf, asset_id, conditionId);
  } catch (err: any) {
    console.error(`[REDEEM] Cannot determine index set for ${asset_id.slice(0, 12)}…: ${err.message}`);
    updateTradeStatus(trade.id, "FAILED");
    return;
  }

  // ── Detect whether tokens sit in EOA or proxy wallet ───────────────────
  const tokenIdBn  = BigNumber.from(asset_id);
  const eoaBal: BigNumber  = await ctf.balanceOf(wallet.address, tokenIdBn);
  const rawProxy   = config.proxyWalletAddress?.trim() ?? "";
  const proxyAddr  = rawProxy && rawProxy.toLowerCase() !== wallet.address.toLowerCase() ? rawProxy : "";
  const proxyBal: BigNumber = proxyAddr
    ? await ctf.balanceOf(proxyAddr, tokenIdBn)
    : BigNumber.from(0);

  const useProxy = eoaBal.isZero() && proxyBal.gt(0);
  if (!eoaBal.gt(0) && !useProxy) {
    console.log(`[REDEEM] No tokens for ${asset_id.slice(0, 12)}… — already redeemed or wrong wallet`);
    updateTradeStatus(trade.id, "FAILED");
    return;
  }

  const viaLabel = useProxy ? "proxy" : "EOA";
  const slug     = trade.slug ?? asset_id.slice(0, 12) + "\u2026";
  console.log(`[REDEEM] ${slug} (${trade.outcome ?? "?"}) via ${viaLabel} indexSet=${indexSet}`);

  // ── Gas overrides (Polygon needs min 30 gwei priority) ─────────────────
  const feeData  = await provider.getFeeData();
  const minPrio  = BigNumber.from("30000000000");
  const priority = (feeData.maxPriorityFeePerGas ?? BigNumber.from(0)).gt(minPrio)
    ? feeData.maxPriorityFeePerGas!
    : minPrio;
  const gas: Record<string, BigNumber> = { maxPriorityFeePerGas: priority };
  if (feeData.maxFeePerGas) gas.maxFeePerGas = feeData.maxFeePerGas.add(priority);

  // ── Submit redemption ───────────────────────────────────────────────────
  const ctfIface   = new utils.Interface(CTF_ABI);
  const redeemData = ctfIface.encodeFunctionData("redeemPositions", [
    USDC_ADDR, constants.HashZero, conditionId, [indexSet],
  ]);

  let txHash: string;
  try {
    if (!useProxy) {
      const tx = await ctf.connect(wallet).redeemPositions(
        USDC_ADDR, constants.HashZero, conditionId, [indexSet], gas
      );
      await tx.wait();
      txHash = tx.hash;
    } else {
      const proxy = new Contract(proxyAddr, PROXY_ABI, wallet);
      const tx    = await proxy.execute(CTF_ADDR, redeemData, { ...gas, value: 0 });
      await tx.wait();
      txHash = tx.hash;
    }
    updateTradeStatus(trade.id, "FILLED", txHash);
    console.log(`[REDEEM] ✓ ${slug} redeemed — tx ${txHash}`);
  } catch (err) {
    updateTradeStatus(trade.id, "FAILED");
    throw err;
  }
}
