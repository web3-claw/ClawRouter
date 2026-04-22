/**
 * OnchainOsAdapter — WalletAdapter backed by OKX's `onchainos` CLI.
 *
 * The CLI owns wallet state (email login, key material, auto-topup); this
 * adapter shells out to it whenever the proxy needs an address or signature.
 * No private keys ever live in XClawRouter's process memory.
 *
 * CLI surface (working assumption — verify against OKX docs before shipping):
 *   onchainos wallet status --json
 *     → { connected: bool, email?: string, evm?: "0x…", solana?: "…" }
 *   onchainos wallet login <email>
 *   onchainos wallet logout
 *   onchainos sign typed-data --chain <base|solana> --data <json-stdin>
 *     → { signature: "0x…" } for EVM
 *   onchainos sign solana-transaction --transaction <base64-stdin>
 *     → { signedTransaction: "<base64>" } for Solana
 *
 * If OKX exposes different commands, change the four wrapper functions
 * (runStatus, runLogin, runLogout, runSign*) — the rest of the codebase
 * depends only on the WalletAdapter interface.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { ClientEvmSigner } from "@x402/evm";
import type { ClientSvmSigner } from "@x402/svm";

import type {
  EvmWalletAdapter,
  SvmWalletAdapter,
  WalletAdapter,
  WalletStatus,
} from "./wallet-adapter.js";

const execFileAsync = promisify(execFile);

const DEFAULT_BIN = "onchainos";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface OnchainOsAdapterOptions {
  /** Override the CLI binary path (defaults to `onchainos` on PATH). */
  bin?: string;
  /** Per-command timeout in ms. Signing should return well under this. */
  timeoutMs?: number;
  /** If true, expose the Solana adapter. Gated on onchainos capability. */
  enableSolana?: boolean;
}

class OnchainOsCliError extends Error {
  constructor(
    message: string,
    readonly stderr?: string,
    readonly exitCode?: number | null,
  ) {
    super(message);
    this.name = "OnchainOsCliError";
  }
}

async function runCli(
  bin: string,
  args: string[],
  opts: { input?: string; timeoutMs: number },
): Promise<string> {
  if (opts.input !== undefined) {
    return runWithStdin(bin, args, opts.input, opts.timeoutMs);
  }
  try {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: opts.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    throw wrapCliError(err, bin, args);
  }
}

function runWithStdin(
  bin: string,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      reject(wrapCliError(err, bin, args));
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new OnchainOsCliError(
          `onchainos ${args.join(" ")} timed out after ${timeoutMs}ms`,
          stderr,
        ),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(wrapCliError(err, bin, args));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else
        reject(
          new OnchainOsCliError(
            `onchainos ${args.join(" ")} exited with code ${code}`,
            stderr,
            code,
          ),
        );
    });
    child.stdin.end(input);
  });
}

function wrapCliError(err: unknown, bin: string, args: string[]): OnchainOsCliError {
  const e = err as NodeJS.ErrnoException & {
    stderr?: string;
    code?: string | number | null;
  };
  if (e.code === "ENOENT") {
    return new OnchainOsCliError(
      `onchainos CLI not found at "${bin}". Install OKX's agentic wallet CLI and ensure it is on PATH, ` +
        `or set XCLAWROUTER_ONCHAINOS_BIN to the binary location.`,
    );
  }
  return new OnchainOsCliError(
    `onchainos ${args.join(" ")} failed: ${e.message}`,
    e.stderr,
    typeof e.code === "number" ? e.code : null,
  );
}

interface RawStatus {
  connected: boolean;
  email?: string;
  evm?: string;
  solana?: string;
}

export class OnchainOsAdapter implements WalletAdapter {
  readonly evm: EvmWalletAdapter;
  readonly svm?: SvmWalletAdapter;

  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(opts: OnchainOsAdapterOptions = {}) {
    this.bin = opts.bin ?? process.env.XCLAWROUTER_ONCHAINOS_BIN ?? DEFAULT_BIN;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.evm = new OnchainOsEvmAdapter(this);
    if (opts.enableSolana) {
      this.svm = new OnchainOsSvmAdapter(this);
    }
  }

  async status(): Promise<WalletStatus> {
    const stdout = await runCli(this.bin, ["wallet", "status", "--json"], {
      timeoutMs: this.timeoutMs,
    });
    const raw = parseJson<RawStatus>(stdout, "wallet status");
    return {
      connected: Boolean(raw.connected),
      email: raw.email,
      evmAddress: raw.evm as `0x${string}` | undefined,
      solanaAddress: raw.solana,
    };
  }

  async login(email: string): Promise<void> {
    if (!email.includes("@")) {
      throw new Error(`Invalid email address: ${email}`);
    }
    await runCli(this.bin, ["wallet", "login", email], {
      // Login involves a confirmation step; allow more time than a signing op.
      timeoutMs: 5 * 60_000,
    });
  }

  async logout(): Promise<void> {
    await runCli(this.bin, ["wallet", "logout"], { timeoutMs: this.timeoutMs });
  }

  /** Internal: sign EIP-712 typed data via the CLI. */
  async signTypedDataEvm(args: {
    chain: "base";
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`> {
    const payload = JSON.stringify({
      domain: args.domain,
      types: args.types,
      primaryType: args.primaryType,
      message: args.message,
    });
    const stdout = await runCli(
      this.bin,
      ["sign", "typed-data", "--chain", args.chain, "--data", "-"],
      { input: payload, timeoutMs: this.timeoutMs },
    );
    const parsed = parseJson<{ signature: string }>(stdout, "sign typed-data");
    if (!parsed.signature?.startsWith("0x")) {
      throw new OnchainOsCliError(
        `onchainos returned an invalid signature: ${parsed.signature}`,
      );
    }
    return parsed.signature as `0x${string}`;
  }

  /** Internal: sign a partially-signed Solana transaction via the CLI. */
  async signSolanaTransaction(transactionBase64: string): Promise<string> {
    const stdout = await runCli(
      this.bin,
      ["sign", "solana-transaction", "--transaction", "-"],
      { input: transactionBase64, timeoutMs: this.timeoutMs },
    );
    const parsed = parseJson<{ signedTransaction: string }>(
      stdout,
      "sign solana-transaction",
    );
    if (!parsed.signedTransaction) {
      throw new OnchainOsCliError(
        "onchainos returned no signedTransaction for Solana signing.",
      );
    }
    return parsed.signedTransaction;
  }
}

class OnchainOsEvmAdapter implements EvmWalletAdapter {
  constructor(private readonly parent: OnchainOsAdapter) {}

  async getAddress(): Promise<`0x${string}`> {
    const s = await this.parent.status();
    if (!s.evmAddress) {
      throw new Error(
        "onchainos reports no EVM address. Run `/wallet login <email>` to connect.",
      );
    }
    return s.evmAddress;
  }

  async toX402Signer(publicClient?: {
    readContract(args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
    }): Promise<unknown>;
  }): Promise<ClientEvmSigner> {
    const address = await this.getAddress();
    const parent = this.parent;
    const signer: ClientEvmSigner = {
      address,
      async signTypedData(message) {
        return parent.signTypedDataEvm({
          chain: "base",
          domain: message.domain,
          types: message.types,
          primaryType: message.primaryType,
          message: message.message,
        });
      },
      readContract: publicClient?.readContract.bind(publicClient),
    };
    return signer;
  }
}

class OnchainOsSvmAdapter implements SvmWalletAdapter {
  constructor(private readonly parent: OnchainOsAdapter) {}

  async getAddress(): Promise<string> {
    const s = await this.parent.status();
    if (!s.solanaAddress) {
      throw new Error(
        "onchainos reports no Solana address. Either Solana support is not available " +
          "in this onchainos release, or the wallet is not connected.",
      );
    }
    return s.solanaAddress;
  }

  async toX402Signer(): Promise<ClientSvmSigner> {
    // @x402/svm's ClientSvmSigner is @solana/kit's TransactionSigner. Building
    // a TransactionSigner that delegates to an out-of-process CLI is non-trivial:
    // we need a signer that can partial-sign transactions and return them in the
    // @solana/kit-native shape. We defer this until OKX confirms onchainos exposes
    // the primitives we need.
    throw new Error(
      "Solana signing via onchainos is not yet implemented. Use Base chain for now, " +
        "or disable Solana support via CLI (`/chain base`).",
    );
  }
}

function parseJson<T>(stdout: string, label: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new OnchainOsCliError(`onchainos ${label}: empty output`);
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch (err) {
    throw new OnchainOsCliError(
      `onchainos ${label}: invalid JSON output — ${(err as Error).message}\n${trimmed.slice(0, 500)}`,
    );
  }
}

export { OnchainOsCliError };
