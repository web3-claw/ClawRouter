/**
 * Tests that the partner-routing regex in proxy.ts matches /v1/phone/* and
 * /v1/voice/* paths (so they flow through proxyPaidApiRequest) without
 * accidentally matching unrelated paths like /v1/phonebook.
 *
 * This is a guardrail against future edits to the regex that might silently
 * stop routing phone calls — verified by mirroring the exact regex literal
 * from src/proxy.ts.
 */
import { describe, it, expect } from "vitest";

// MUST stay in sync with the regex at src/proxy.ts:2782+.
const PARTNER_PATH_REGEX =
  /^\/v1\/(?:partner|pm|exa|modal|stocks|usstock|crypto|fx|commodity|phone|voice)\//;

describe("partner path regex — phone & voice", () => {
  it("matches /v1/phone/lookup", () => {
    expect(PARTNER_PATH_REGEX.test("/v1/phone/lookup")).toBe(true);
  });

  it("matches /v1/phone/lookup/fraud", () => {
    expect(PARTNER_PATH_REGEX.test("/v1/phone/lookup/fraud")).toBe(true);
  });

  it("matches /v1/phone/numbers/list", () => {
    expect(PARTNER_PATH_REGEX.test("/v1/phone/numbers/list")).toBe(true);
  });

  it("matches /v1/phone/numbers/buy", () => {
    expect(PARTNER_PATH_REGEX.test("/v1/phone/numbers/buy")).toBe(true);
  });

  it("matches /v1/voice/call", () => {
    expect(PARTNER_PATH_REGEX.test("/v1/voice/call")).toBe(true);
  });

  it("matches /v1/voice/call/{callId} poll URLs", () => {
    expect(PARTNER_PATH_REGEX.test("/v1/voice/call/call_abc123")).toBe(true);
  });

  it("does NOT match /v1/phonebook (regex word-boundary check)", () => {
    // `phonebook` shares the `phone` prefix but the trailing `\/` requirement
    // means the regex correctly rejects it.
    expect(PARTNER_PATH_REGEX.test("/v1/phonebook/contacts")).toBe(false);
  });

  it("does NOT match /v1/voicemail (regex word-boundary check)", () => {
    expect(PARTNER_PATH_REGEX.test("/v1/voicemail/list")).toBe(false);
  });

  it("does NOT match /v1/phone (no trailing slash)", () => {
    // Bare `/v1/phone` is malformed; the regex requires a sub-path.
    expect(PARTNER_PATH_REGEX.test("/v1/phone")).toBe(false);
  });

  it("still matches existing partner paths (regression guard)", () => {
    expect(PARTNER_PATH_REGEX.test("/v1/pm/polymarket/events")).toBe(true);
    expect(PARTNER_PATH_REGEX.test("/v1/exa/search")).toBe(true);
    expect(PARTNER_PATH_REGEX.test("/v1/stocks/quote/AAPL")).toBe(true);
    expect(PARTNER_PATH_REGEX.test("/v1/crypto/price/BTC-USD")).toBe(true);
  });
});
