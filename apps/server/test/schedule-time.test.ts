import { describe, expect, it } from "vitest";
import {
  formatDateTimeInTimezone,
  nowClockInTimezone,
  nowMinutesInTimezone,
} from "../src/schedule/time.js";

describe("schedule clock helpers", () => {
  it("formats a UTC ISO timestamp in the user's timezone", () => {
    const iso = "2026-11-20T17:33:00.000Z";
    expect(formatDateTimeInTimezone(iso, "Asia/Shanghai")).toBe(
      "2026-11-21 01:33",
    );
    expect(formatDateTimeInTimezone(iso, "UTC")).toBe("2026-11-20 17:33");
    expect(formatDateTimeInTimezone(iso, "America/New_York")).toBe(
      "2026-11-20 12:33",
    );
  });

  it("keeps an invalid timestamp untouched", () => {
    expect(formatDateTimeInTimezone("not-a-date", "Asia/Shanghai")).toBe(
      "not-a-date",
    );
  });

  it("returns a wall clock consistent with the current time", () => {
    const zone = "Asia/Shanghai";
    const minutes = nowMinutesInTimezone(zone);
    const clock = nowClockInTimezone(zone);
    expect(minutes).toBeGreaterThanOrEqual(0);
    expect(minutes).toBeLessThan(24 * 60);
    expect(clock).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
  });
});
