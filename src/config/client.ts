import * as fs from "fs";
import * as path from "path";
import { Wallet, providers, Contract, constants, utils, BigNumber } from "ethers";
import { ClobClient, Chain } from "@polymarket/clob-client";
import { SignatureType } from "@polymarket/clob-client";
import type { AppConfig } from "../types";

const { JsonRpcProvider } = providers;
const { MaxUint256 } = constants;
const { getAddress } = utils;

// Polygon Mainnet RPC — prefer Alchemy if key provided, fall back to public node
const _alchemyKey = process.env.ALCHEMY_API_KEY?.trim();
const POLYGON_RPC = process.env.POLYGON_RPC?.trim()
  ?? (_alchemyKey ? `https://polygon-mainnet.g.alchemy.com/v2/${_alchemyKey}` : "https://polygon-rpc.com");

// Polymarket exchange contracts that need USDC.e approval (from @polymarket/clob-client config)
const CTF_EXCHANGE = getAddress("0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e");
const NEG_RISK_CTF_EXCHANGE = getAddress("0xc5d563a36ae78145c45a50134d48a1215220f80a");
const NEG_RISK_ADAPTER = getAddress("0xd91e80cf2e7be2e162c6513ced06f1dd0da35296");
// USDC.e (bridged) on Polygon — this is what Polymarket uses, NOT native USDC
const USDC_POLYGON = getAddress("0x2791bca1f2de4661ed88a30c99a7a9449aa84174");

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// Polymarket ERC-1155 conditional token contract — needs setApprovalForAll for SELL orders
const CTF_TOKEN_CONTRACT = getAddress("0x4d97dcd97ec945f40cf65f87097ace5ea0476045");

const ERC1155_ABI = [
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
];

/** Persist derived API credentials back into the .env file so we skip the
 *  createOrDeriveApiKey network call on every subsequent startup. */
function saveCredentialsToEnv(key: string, secret: string, passphrase: string) {
  const envPath = path.join(process.cwd(), ".env");
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  const fields: Record<string, string> = { API_KEY: key, API_SECRET: secret, API_PASSPHRASE: passphrase };
  for (const [k, v] of Object.entries(fields)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    if (re.test(content)) {
      content = content.replace(re, `${k}=${v}`);
    } else {
      content += `\n${k}=${v}`;
    }
  }
  fs.writeFileSync(envPath, content, "utf-8");
}

/** Check USDC allowance for both Polymarket exchange contracts and approve
 *  MaxUint256 for any that are insufficiently approved. */
export async function ensureUsdcApproval(walletPrivateKey: string, chainId: number): Promise<void> {
  if (chainId !== 137) return; // only mainnet
  const rpc = POLYGON_RPC;
  const provider = new JsonRpcProvider(rpc);
  const pk = walletPrivateKey.startsWith("0x") ? walletPrivateKey : "0x" + walletPrivateKey;
  const signer = new Wallet(pk, provider);
  const usdc = new Contract(USDC_POLYGON, ERC20_ABI, signer);
  const owner = await signer.getAddress();

  // Log current USDC balance
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bal: any = await usdc.balanceOf(owner);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dec: any = await usdc.decimals();
  const balHuman = (Number(bal.toString()) / 10 ** Number(dec)).toFixed(2);
  console.log(`[USDC] Balance: $${balHuman} (${owner})`);

  // Polygon needs a higher priority fee (min ~25 gwei); ethers v5 default is too low
  const feeData = await provider.getFeeData();
  const minPriority = BigNumber.from("30000000000"); // 30 gwei
  const currentPriority = feeData.maxPriorityFeePerGas ?? BigNumber.from(0);
  const gasOverrides: { maxPriorityFeePerGas: BigNumber; maxFeePerGas?: BigNumber } = {
    maxPriorityFeePerGas: currentPriority.gt(minPriority) ? currentPriority : minPriority,
  };
  if (feeData.maxFeePerGas) {
    gasOverrides.maxFeePerGas = feeData.maxFeePerGas.add(gasOverrides.maxPriorityFeePerGas);
  }

  for (const spender of [CTF_EXCHANGE, NEG_RISK_CTF_EXCHANGE, NEG_RISK_ADAPTER]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allowance: any = await usdc.allowance(owner, spender);
    const threshold = BigInt(10) * BigInt(10) ** BigInt(Number(dec));
    const allowanceBig = BigInt(allowance.toString());
    if (allowanceBig < threshold) {
      const label = spender === CTF_EXCHANGE ? "CTF Exchange" : spender === NEG_RISK_CTF_EXCHANGE ? "NegRisk Exchange" : "NegRisk Adapter";
      console.log(`[USDC] Approving ${label} (current=$${(Number(allowance.toString()) / 10 ** Number(dec)).toFixed(2)}) …`);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tx: any = await usdc.approve(spender, MaxUint256, gasOverrides);
        await tx.wait();
        console.log(`[USDC] Approved ${label} ✓`);
      } catch (e: any) {
        console.error(`[USDC] Approve ${label} failed: ${e.reason ?? e.message}`);
      }
    }
  }

  // ── ERC-1155 setApprovalForAll (needed to SELL outcome tokens) ──────────
  const ctf = new Contract(CTF_TOKEN_CONTRACT, ERC1155_ABI, signer);
  for (const operator of [CTF_EXCHANGE, NEG_RISK_CTF_EXCHANGE, NEG_RISK_ADAPTER]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const approved: any = await ctf.isApprovedForAll(owner, operator);
    if (!approved) {
      const label = operator === CTF_EXCHANGE ? "CTF Exchange" : operator === NEG_RISK_CTF_EXCHANGE ? "NegRisk Exchange" : "NegRisk Adapter";
      console.log(`[CTF] setApprovalForAll → ${label} …`);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tx: any = await ctf.setApprovalForAll(operator, true, gasOverrides);
        await tx.wait();
        console.log(`[CTF] Approved ${label} ✓`);
      } catch (e: any) {
        console.error(`[CTF] ApproveAll ${label} failed: ${e.reason ?? e.message}`);
      }
    }
  }
}

export async function createClient(config: AppConfig): Promise<ClobClient> {
  const { clobHost, chainId, walletPrivateKey, proxyWalletAddress, signatureType } = config;
  const chain = chainId === 137 ? Chain.POLYGON : Chain.AMOY;
  const pk = walletPrivateKey.startsWith("0x") ? walletPrivateKey : "0x" + walletPrivateKey;
  const wallet = new Wallet(pk);
  const sigType = signatureType as SignatureType;
  const funder = proxyWalletAddress || undefined;

  // ── Use cached credentials from .env if available ──────────────────────────
  const envKey = process.env.API_KEY?.trim();
  const envSecret = process.env.API_SECRET?.trim();
  const envPassphrase = process.env.API_PASSPHRASE?.trim();
  if (envKey && envSecret && envPassphrase) {
    const creds = { key: envKey, secret: envSecret, passphrase: envPassphrase };
    return new ClobClient(clobHost, chain, wallet, creds, sigType, funder);
  }

  // ── Derive from wallet signature and cache for next run ────────────────────
  const tempClient = new ClobClient(clobHost, chain, wallet, undefined, sigType, funder);
  const creds = await tempClient.createOrDeriveApiKey();
  if (creds?.key && creds?.secret && creds?.passphrase) {
    saveCredentialsToEnv(creds.key, creds.secret, creds.passphrase);
    console.log("[AUTH] API credentials derived and saved to .env ✓");
  }
  return new ClobClient(clobHost, chain, wallet, creds, sigType, funder);
}
