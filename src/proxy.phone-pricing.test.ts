/**
 * Tests for estimatePhoneCost — telemetry-only pricing fallback for /v1/phone/*
 * and /v1/voice/* paths. Server-side x402 is authoritative for actual settlement;
 * this table only drives logUsage when paymentStore is empty.
 */
import { describe, it, expect } from "vitest";

import { estimatePhoneCost, resolvePhoneTelemetryCost } from "./proxy.js";

describe("estimatePhoneCost", () => {
  it("returns $0.01 for /v1/phone/lookup", () => {
    expect(estimatePhoneCost("/v1/phone/lookup")).toBe(0.01);
  });

  it("returns $0.05 for /v1/phone/lookup/fraud (longest-prefix wins)", () => {
    expect(estimatePhoneCost("/v1/phone/lookup/fraud")).toBe(0.05);
  });

  it("returns $5.00 for /v1/phone/numbers/buy", () => {
    expect(estimatePhoneCost("/v1/phone/numbers/buy")).toBe(5.0);
  });

  it("returns $5.00 for /v1/phone/numbers/renew", () => {
    expect(estimatePhoneCost("/v1/phone/numbers/renew")).toBe(5.0);
  });

  it("returns $0.001 for /v1/phone/numbers/list", () => {
    expect(estimatePhoneCost("/v1/phone/numbers/list")).toBe(0.001);
  });

  it("returns $0 (free) for /v1/phone/numbers/release", () => {
    expect(estimatePhoneCost("/v1/phone/numbers/release")).toBe(0);
  });

  it("returns $0.54 for /v1/voice/call", () => {
    expect(estimatePhoneCost("/v1/voice/call")).toBe(0.54);
  });

  it("resolves /v1/voice/call/{callId} poll URL to the same $0.54 row", () => {
    // Longest-prefix matching: /v1/voice/call/abc123 starts with `voice/call/`
    // so it picks up the voice/call entry.
    expect(estimatePhoneCost("/v1/voice/call/call_abc123")).toBe(0.54);
  });

  it("strips query strings before matching", () => {
    expect(estimatePhoneCost("/v1/phone/lookup?phoneNumber=%2B14155552671")).toBe(0.01);
  });

  it("falls back to $0.05 for unknown phone/voice operation", () => {
    expect(estimatePhoneCost("/v1/phone/something-new")).toBe(0.05);
    expect(estimatePhoneCost("/v1/voice/transcribe")).toBe(0.05);
  });

  it("disambiguates lookup vs lookup/fraud correctly", () => {
    // /v1/phone/lookup is shorter than /v1/phone/lookup/fraud, but the URL
    // /v1/phone/lookup must match /v1/phone/lookup, not /v1/phone/lookup/fraud.
    expect(estimatePhoneCost("/v1/phone/lookup")).toBe(0.01);
    expect(estimatePhoneCost("/v1/phone/lookup/fraud")).toBe(0.05);
  });
});

describe("resolvePhoneTelemetryCost — telemetry gates", () => {
  it("uses the actual paid amount when > 0, regardless of other gates", () => {
    // The x402 payment header is authoritative — don't second-guess it.
    expect(
      resolvePhoneTelemetryCost({
        paidAmount: 0.42,
        isPhone: true,
        upstreamStatus: 200,
        method: "POST",
        urlPath: "/v1/voice/call",
      }),
    ).toBe(0.42);
  });

  it("uses the actual paid amount even when upstream failed (server already settled)", () => {
    expect(
      resolvePhoneTelemetryCost({
        paidAmount: 0.54,
        isPhone: true,
        upstreamStatus: 500,
        method: "POST",
        urlPath: "/v1/voice/call",
      }),
    ).toBe(0.54);
  });

  it("falls back to PHONE_PRICING for a successful phone POST when paymentStore is empty", () => {
    // Cached pre-auth path: settlement happened but paymentStore wasn't populated.
    expect(
      resolvePhoneTelemetryCost({
        paidAmount: 0,
        isPhone: true,
        upstreamStatus: 200,
        method: "POST",
        urlPath: "/v1/voice/call",
      }),
    ).toBe(0.54);
  });

  it("BUG GUARD: returns 0 (not $0.54) for a 4xx phone POST — phantom-charge fix", () => {
    // Repro of the smoke-test finding: POST /v1/voice/call with malformed body
    // returned 400 from BlockRun. No wallet debit happened, so we must NOT
    // record a phantom $0.54 charge in stats.
    expect(
      resolvePhoneTelemetryCost({
        paidAmount: 0,
        isPhone: true,
        upstreamStatus: 400,
        method: "POST",
        urlPath: "/v1/voice/call",
      }),
    ).toBe(0);
  });

  it("BUG GUARD: returns 0 for a GET poll on /voice/call/{id} — free-poll fix", () => {
    // Repro: polling GET /v1/voice/call/{callId} is FREE upstream. Without the
    // POST-only gate, the longest-prefix match on `voice/call/` would credit
    // every poll as another $0.54 voice call.
    expect(
      resolvePhoneTelemetryCost({
        paidAmount: 0,
        isPhone: true,
        upstreamStatus: 200,
        method: "GET",
        urlPath: "/v1/voice/call/d5bac7b6-8512-4ef9-96a2-242294dfe5b2",
      }),
    ).toBe(0);
  });

  it("returns 0 for non-phone partner requests (no fallback)", () => {
    // The phone fallback is only for phone/voice paths. Other partners use
    // paidAmount directly.
    expect(
      resolvePhoneTelemetryCost({
        paidAmount: 0,
        isPhone: false,
        upstreamStatus: 200,
        method: "POST",
        urlPath: "/v1/pm/polymarket/events",
      }),
    ).toBe(0);
  });

  it("returns 0 for a 5xx phone POST (upstream crashed after settlement attempt)", () => {
    expect(
      resolvePhoneTelemetryCost({
        paidAmount: 0,
        isPhone: true,
        upstreamStatus: 502,
        method: "POST",
        urlPath: "/v1/phone/lookup",
      }),
    ).toBe(0);
  });

  it("returns 0 for missing/undefined HTTP method", () => {
    expect(
      resolvePhoneTelemetryCost({
        paidAmount: 0,
        isPhone: true,
        upstreamStatus: 200,
        method: undefined,
        urlPath: "/v1/phone/lookup",
      }),
    ).toBe(0);
  });
});
