import { afterEach, describe, expect, it } from "vitest";
import { isBlockrunWebSearchDisabled } from "./index.js";

const ENV_KEY = "BLOCKRUN_WEB_SEARCH";

describe("isBlockrunWebSearchDisabled", () => {
  const originalEnv = process.env[ENV_KEY];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalEnv;
    }
  });

  describe("env var BLOCKRUN_WEB_SEARCH", () => {
    it("returns true when set to 'off' (lowercase)", () => {
      process.env[ENV_KEY] = "off";
      expect(isBlockrunWebSearchDisabled()).toBe(true);
    });

    it("returns true when set to 'OFF' (uppercase) — case-insensitive", () => {
      process.env[ENV_KEY] = "OFF";
      expect(isBlockrunWebSearchDisabled()).toBe(true);
    });

    it("returns true when set to 'Off' (mixed case)", () => {
      process.env[ENV_KEY] = "Off";
      expect(isBlockrunWebSearchDisabled()).toBe(true);
    });

    it("env 'off' overrides config (even when config says enabled=true)", () => {
      process.env[ENV_KEY] = "off";
      expect(isBlockrunWebSearchDisabled({ tools: { web: { search: { enabled: true } } } })).toBe(
        true,
      );
    });

    it("returns false when set to 'on'", () => {
      process.env[ENV_KEY] = "on";
      expect(isBlockrunWebSearchDisabled()).toBe(false);
    });

    it("returns false when set to '1' (only 'off' counts as disabled)", () => {
      process.env[ENV_KEY] = "1";
      expect(isBlockrunWebSearchDisabled()).toBe(false);
    });

    it("returns false when set to empty string", () => {
      process.env[ENV_KEY] = "";
      expect(isBlockrunWebSearchDisabled()).toBe(false);
    });

    it("falls through to config when env unset", () => {
      delete process.env[ENV_KEY];
      expect(isBlockrunWebSearchDisabled({ tools: { web: { search: { enabled: false } } } })).toBe(
        true,
      );
      expect(isBlockrunWebSearchDisabled({ tools: { web: { search: { enabled: true } } } })).toBe(
        false,
      );
    });
  });

  describe("config tools.web.search.enabled", () => {
    afterEach(() => {
      delete process.env[ENV_KEY];
    });

    it("returns true when enabled === false", () => {
      expect(isBlockrunWebSearchDisabled({ tools: { web: { search: { enabled: false } } } })).toBe(
        true,
      );
    });

    it("returns false when enabled === true", () => {
      expect(isBlockrunWebSearchDisabled({ tools: { web: { search: { enabled: true } } } })).toBe(
        false,
      );
    });

    it("returns false when enabled is undefined (default — auto-enable)", () => {
      expect(isBlockrunWebSearchDisabled({ tools: { web: { search: {} } } })).toBe(false);
    });

    it("returns false on empty config", () => {
      expect(isBlockrunWebSearchDisabled({})).toBe(false);
    });

    it("returns false on undefined config", () => {
      expect(isBlockrunWebSearchDisabled()).toBe(false);
    });

    it("returns false when enabled is 'false' string (only strict boolean false counts)", () => {
      // This is intentional — non-boolean values are user error and we conservatively
      // do not treat them as opt-out, matching the existing config validator's strictness.
      expect(
        isBlockrunWebSearchDisabled({ tools: { web: { search: { enabled: "false" } } } }),
      ).toBe(false);
    });

    it("handles missing tools/web/search nesting gracefully", () => {
      expect(isBlockrunWebSearchDisabled({ tools: {} })).toBe(false);
      expect(isBlockrunWebSearchDisabled({ tools: { web: {} } })).toBe(false);
      expect(isBlockrunWebSearchDisabled({ unrelated: "value" })).toBe(false);
    });

    it("ignores non-object tools/web/search (defensive)", () => {
      expect(isBlockrunWebSearchDisabled({ tools: null })).toBe(false);
      expect(isBlockrunWebSearchDisabled({ tools: { web: null } })).toBe(false);
    });
  });
});
