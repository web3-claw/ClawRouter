/**
 * Tests for parseCallArgs — parses the /cr-call slash command argument string.
 *
 * Shape: `/cr-call +1<E.164> "<task>" [--voice nat] [--max-duration 5]
 *                                    [--from +1<owned>] [--language en-US]`
 *
 * - First +E.164-shaped token wins as `to`.
 * - All remaining non-flag tokens (or quoted spans) join into `task`.
 * - Flags accept BOTH `--key value` and `--key=value` forms.
 */
import { describe, it, expect } from "vitest";

import { parseCallArgs } from "./index.js";

describe("parseCallArgs", () => {
  it("parses bare to + task", () => {
    const result = parseCallArgs('+14155552671 "Tell them about the meeting"');
    expect(result.to).toBe("+14155552671");
    expect(result.task).toBe("Tell them about the meeting");
  });

  it("parses task as joined unquoted words when no quotes used", () => {
    const result = parseCallArgs("+14155552671 confirm tomorrow 3pm");
    expect(result.to).toBe("+14155552671");
    expect(result.task).toBe("confirm tomorrow 3pm");
  });

  it("recognizes --voice flag in space-separated form", () => {
    const result = parseCallArgs('+14155552671 "say hi" --voice josh');
    expect(result.voice).toBe("josh");
    expect(result.task).toBe("say hi");
  });

  it("recognizes --voice flag in =-separated form", () => {
    const result = parseCallArgs('+14155552671 "say hi" --voice=josh');
    expect(result.voice).toBe("josh");
  });

  it("recognizes --max-duration flag (both dash and underscore variants)", () => {
    expect(parseCallArgs('+14155552671 "x" --max-duration 10').max_duration).toBe(10);
    expect(parseCallArgs('+14155552671 "x" --max-duration=10').max_duration).toBe(10);
    expect(parseCallArgs('+14155552671 "x" --max_duration 7').max_duration).toBe(7);
    expect(parseCallArgs('+14155552671 "x" --max_duration=7').max_duration).toBe(7);
  });

  it("recognizes --from for wallet-owned caller ID", () => {
    const result = parseCallArgs('+14155552671 "x" --from +14155551234');
    expect(result.from).toBe("+14155551234");
  });

  it("recognizes --language and --lang as aliases", () => {
    expect(parseCallArgs('+14155552671 "x" --language es-ES').language).toBe("es-ES");
    expect(parseCallArgs('+14155552671 "x" --lang zh-CN').language).toBe("zh-CN");
  });

  it("supports all flags together", () => {
    const result = parseCallArgs(
      '+14155552671 "Confirm meeting" --voice maya --max-duration 8 --from +14155551234 --language en-US',
    );
    expect(result.to).toBe("+14155552671");
    expect(result.task).toBe("Confirm meeting");
    expect(result.voice).toBe("maya");
    expect(result.max_duration).toBe(8);
    expect(result.from).toBe("+14155551234");
    expect(result.language).toBe("en-US");
  });

  it("returns no `to` when no E.164-shaped token is present", () => {
    const result = parseCallArgs('"just a message" --voice nat');
    expect(result.to).toBeUndefined();
    expect(result.task).toBe("just a message");
    expect(result.voice).toBe("nat");
  });

  it("returns empty task when only +E.164 is provided", () => {
    const result = parseCallArgs("+14155552671");
    expect(result.to).toBe("+14155552671");
    expect(result.task).toBe("");
  });

  it("rejects non-E.164 phone-like tokens (no leading + or wrong length)", () => {
    // 415-555-2671 without + → does not match the +\d{6,15} pattern, treated as task tokens
    const result = parseCallArgs("4155552671 task here");
    expect(result.to).toBeUndefined();
    expect(result.task).toBe("4155552671 task here");
  });

  it("accepts only the FIRST +E.164 token as `to` (subsequent ones go into task)", () => {
    const result = parseCallArgs('+14155552671 "call +14155551111 and confirm"');
    expect(result.to).toBe("+14155552671");
    expect(result.task).toBe("call +14155551111 and confirm");
  });

  it("handles empty input gracefully", () => {
    const result = parseCallArgs("");
    expect(result.to).toBeUndefined();
    expect(result.task).toBe("");
  });

  it("ignores invalid max-duration values (Number returns NaN)", () => {
    const result = parseCallArgs('+14155552671 "x" --max-duration abc');
    expect(result.max_duration).toBeUndefined();
  });
});
