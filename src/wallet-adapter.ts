/**
 * WalletAdapter — signing backend seam for XClawRouter.
 *
 * The proxy owns routing, caching, and x402 registration; it delegates
 * the actual wallet state (address, signing) to an adapter. This keeps
 * the OKX `onchainos` CLI integration isolated from the rest of the
 * proxy, and leaves room for alternative backends (tests, future
 * hardware-wallet support) behind the same interface.
 */

import type { ClientEvmSigner } from "@x402/evm";
import type { ClientSvmSigner } from "@x402/svm";

export interface WalletStatus {
  connected: boolean;
  email?: string;
  evmAddress?: `0x${string}`;
  solanaAddress?: string;
}

export interface EvmWalletAdapter {
  getAddress(): Promise<`0x${string}`>;
  /**
   * Produce an x402 ClientEvmSigner. The optional public client provides
   * on-chain read capability for extensions (EIP-2612 / ERC-20 approvals);
   * the signer object itself only needs to implement `signTypedData`.
   */
  toX402Signer(publicClient?: {
    readContract(args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
    }): Promise<unknown>;
  }): Promise<ClientEvmSigner>;
}

export interface SvmWalletAdapter {
  getAddress(): Promise<string>;
  toX402Signer(): Promise<ClientSvmSigner>;
}

export interface WalletAdapter {
  readonly evm: EvmWalletAdapter;
  /** Present only if the underlying backend can sign on Solana. */
  readonly svm?: SvmWalletAdapter;
  status(): Promise<WalletStatus>;
  login(email: string): Promise<void>;
  logout(): Promise<void>;
}
