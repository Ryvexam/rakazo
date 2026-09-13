import { describe, expect, it } from "vitest";
import {
  autonomyCron,
  buildAutonomyPrompt,
  goalTitle,
  heartbeatFromCrons,
  ideaTitle,
  isAutonomyPrompt,
  isIdeaTitle,
  parseAutonomyMode,
} from "./autonomy";

describe("autonomy helpers", () => {
  it("round-trips supported heartbeat intervals", () => {
    expect(heartbeatFromCrons([autonomyCron(15)])).toBe(15);
    expect(heartbeatFromCrons([autonomyCron(30)])).toBe(30);
    expect(heartbeatFromCrons([autonomyCron(60)])).toBe(60);
    expect(heartbeatFromCrons([autonomyCron(120)])).toBe(120);
  });

  it("marks generated autonomy prompts and restores their mode", () => {
    for (const mode of ["continue", "propose", "autonomous"] as const) {
      const prompt = buildAutonomyPrompt(mode);
      expect(isAutonomyPrompt(prompt)).toBe(true);
      expect(parseAutonomyMode(prompt)).toBe(mode);
    }
  });

  it("keeps product discovery focused on feature work", () => {
    const prompt = buildAutonomyPrompt("propose");
    expect(prompt).toContain("user-facing features");
    expect(prompt).toContain("Do NOT generate work whose primary value is refactoring");
    expect(prompt).toContain("voice speed control");
    expect(prompt).toContain("at most three worthwhile ideas");
  });

  it("converts ideas to goals without leaking the marker", () => {
    expect(isIdeaTitle("[idea] Voice speed")).toBe(true);
    expect(ideaTitle("Voice speed")).toBe("[idea] Voice speed");
    expect(goalTitle("[idea] Voice speed")).toBe("Voice speed");
  });
});
