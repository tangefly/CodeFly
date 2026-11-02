import { describe, expect, it } from "vitest";
import { findDenial, isRunnerFailure, stripAnsi } from "../src/exec/classify.js";

describe("output classification", () => {
  it("strips CSI and OSC escapes", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
    expect(stripAnsi("\u001b]0;title\u0007text")).toBe("text");
  });

  it("finds a denial line", () => {
    const stderr =
      "touch: cannot touch '/home/u/x': Permission denied\n";
    expect(
      findDenial(stderr, ["permission denied"], ["landlock-run: "]),
    ).toContain("Permission denied");
  });

  it("ignores runner-owned diagnostics", () => {
    const stderr =
      "landlock-run: permission denied while opening grant root\n";
    expect(
      findDenial(stderr, ["permission denied"], ["landlock-run: "]),
    ).toBeNull();
  });

  it("requires exit 125 and a runner signature for runner failure", () => {
    const stderr = "landlock-run: exec failed\n";
    expect(isRunnerFailure(125, stderr, ["landlock-run: "])).toBe(true);
    expect(isRunnerFailure(1, stderr, ["landlock-run: "])).toBe(false);
    expect(isRunnerFailure(125, "command failed\n", ["landlock-run: "])).toBe(
      false,
    );
  });
});
