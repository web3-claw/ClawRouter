/**
 * Unit tests for OnchainOsAdapter.
 *
 * We mock the CLI by pointing `bin` at a small node script that prints the
 * responses we want for each invocation. This avoids depending on the real
 * `onchainos` binary while still exercising the process-spawning code paths.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OnchainOsAdapter, OnchainOsCliError } from "./onchainos-adapter.js";

let tmpDir: string;

async function writeFakeCli(
  name: string,
  script: string,
): Promise<string> {
  const path = join(tmpDir, name);
  await writeFile(path, `#!/usr/bin/env node\n${script}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "onchainos-adapter-test-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("OnchainOsAdapter.status", () => {
  it("parses connected wallet status JSON", async () => {
    const bin = await writeFakeCli(
      "status-ok",
      `
      const [,, ...args] = process.argv;
      if (args.join(" ") === "wallet status --json") {
        process.stdout.write(JSON.stringify({
          connected: true,
          email: "vicky.fuyu@gmail.com",
          evm: "0x1234567890123456789012345678901234567890",
          solana: "SoLaNa1111111111111111111111111111111111111"
        }));
        process.exit(0);
      }
      process.exit(2);
      `,
    );
    const adapter = new OnchainOsAdapter({ bin });
    const status = await adapter.status();
    expect(status.connected).toBe(true);
    expect(status.email).toBe("vicky.fuyu@gmail.com");
    expect(status.evmAddress).toBe("0x1234567890123456789012345678901234567890");
    expect(status.solanaAddress).toBe("SoLaNa1111111111111111111111111111111111111");
  });

  it("reports disconnected state when CLI returns connected:false", async () => {
    const bin = await writeFakeCli(
      "status-disconnected",
      `process.stdout.write(JSON.stringify({ connected: false })); process.exit(0);`,
    );
    const adapter = new OnchainOsAdapter({ bin });
    const status = await adapter.status();
    expect(status.connected).toBe(false);
    expect(status.evmAddress).toBeUndefined();
  });

  it("throws OnchainOsCliError when binary is missing", async () => {
    const adapter = new OnchainOsAdapter({
      bin: join(tmpDir, "does-not-exist"),
    });
    await expect(adapter.status()).rejects.toBeInstanceOf(OnchainOsCliError);
  });

  it("throws on invalid JSON output", async () => {
    const bin = await writeFakeCli(
      "status-bad-json",
      `process.stdout.write("not json at all"); process.exit(0);`,
    );
    const adapter = new OnchainOsAdapter({ bin });
    await expect(adapter.status()).rejects.toMatchObject({
      name: "OnchainOsCliError",
    });
  });
});

describe("OnchainOsAdapter EVM signing", () => {
  it("produces a ClientEvmSigner that delegates signTypedData to the CLI", async () => {
    const bin = await writeFakeCli(
      "evm-signer",
      `
      const [,, ...args] = process.argv;
      if (args[0] === "wallet" && args[1] === "status") {
        process.stdout.write(JSON.stringify({
          connected: true,
          evm: "0xAbcDef0000000000000000000000000000000001"
        }));
        process.exit(0);
      }
      if (args[0] === "sign" && args[1] === "typed-data") {
        let payload = "";
        process.stdin.on("data", (c) => payload += c);
        process.stdin.on("end", () => {
          // Echo back a deterministic 65-byte hex signature.
          process.stdout.write(JSON.stringify({
            signature: "0x" + "ab".repeat(65),
            receivedPrimaryType: JSON.parse(payload).primaryType,
          }));
          process.exit(0);
        });
        return;
      }
      process.exit(2);
      `,
    );
    const adapter = new OnchainOsAdapter({ bin });
    const signer = await adapter.evm.toX402Signer();
    expect(signer.address).toBe("0xAbcDef0000000000000000000000000000000001");
    const sig = await signer.signTypedData({
      domain: { name: "USDC", chainId: 8453 },
      types: { TransferWithAuthorization: [] },
      primaryType: "TransferWithAuthorization",
      message: { from: signer.address, value: "1000" },
    });
    expect(sig).toBe("0x" + "ab".repeat(65));
  });

  it("rejects invalid signatures from the CLI", async () => {
    const bin = await writeFakeCli(
      "evm-bad-sig",
      `
      const [,, ...args] = process.argv;
      if (args[0] === "wallet") {
        process.stdout.write(JSON.stringify({
          connected: true,
          evm: "0x0000000000000000000000000000000000000001"
        }));
        process.exit(0);
      }
      process.stdin.on("data", () => {});
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ signature: "not-hex" }));
        process.exit(0);
      });
      `,
    );
    const adapter = new OnchainOsAdapter({ bin });
    const signer = await adapter.evm.toX402Signer();
    await expect(
      signer.signTypedData({
        domain: {},
        types: {},
        primaryType: "X",
        message: {},
      }),
    ).rejects.toBeInstanceOf(OnchainOsCliError);
  });
});

describe("OnchainOsAdapter SVM gating", () => {
  it("does not expose svm adapter unless enableSolana is set", () => {
    const adapter = new OnchainOsAdapter({ bin: "irrelevant" });
    expect(adapter.svm).toBeUndefined();
  });

  it("exposes svm adapter when enableSolana is true (signing still TODO)", async () => {
    const bin = await writeFakeCli(
      "svm-status",
      `process.stdout.write(JSON.stringify({ connected: true, solana: "AbC" })); process.exit(0);`,
    );
    const adapter = new OnchainOsAdapter({ bin, enableSolana: true });
    expect(adapter.svm).toBeDefined();
    await expect(adapter.svm!.getAddress()).resolves.toBe("AbC");
    await expect(adapter.svm!.toX402Signer()).rejects.toThrow(/not yet implemented/);
  });
});

describe("OnchainOsAdapter.login validation", () => {
  it("rejects malformed emails before invoking the CLI", async () => {
    const adapter = new OnchainOsAdapter({
      bin: join(tmpDir, "unused"),
    });
    await expect(adapter.login("not-an-email")).rejects.toThrow(
      /Invalid email/,
    );
  });
});
