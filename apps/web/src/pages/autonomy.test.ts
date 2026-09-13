import { describe, expect, it } from "vitest";
import {
  AUTONOMOUS_GOAL_MARKER,
  autonomyCron,
  buildAutonomousPromotedGoalNotes,
  buildAutonomyPrompt,
  buildUserPromotedGoalNotes,
  exceedsGoalChainDepth,
  goalTitle,
  heartbeatFromCrons,
  ideaTitle,
  isAutonomyPrompt,
  isIdeaTitle,
  OPPORTUNITY_MARKER,
  parseAutonomyLimits,
  parseAutonomyMode,
  parseOpportunityMetadata,
  SCRATCHPAD_NOTES_MAX,
  USER_PROMOTED_GOAL_MARKER,
  visibleWorkNotes,
} from "./autonomy";

describe("autonomy helpers", () => {
  it("round-trips supported heartbeat intervals", () => {
    expect(heartbeatFromCrons([autonomyCron(15)])).toBe(15);
    expect(heartbeatFromCrons([autonomyCron(30)])).toBe(30);
    expect(heartbeatFromCrons([autonomyCron(60)])).toBe(60);
    expect(heartbeatFromCrons([autonomyCron(120)])).toBe(120);
  });

  it("marks generated autonomy prompts and restores their mode and limits", () => {
    for (const mode of ["continue", "propose", "autonomous"] as const) {
      const prompt = buildAutonomyPrompt(mode, { maxGoalsPerDay: 5, maxChainDepth: 2 });
      expect(isAutonomyPrompt(prompt)).toBe(true);
      expect(parseAutonomyMode(prompt)).toBe(mode);
      expect(parseAutonomyLimits(prompt)).toEqual({ maxGoalsPerDay: 5, maxChainDepth: 2 });
    }
  });

  it("keeps product discovery focused on feature work and bounded autonomy", () => {
    const prompt = buildAutonomyPrompt("autonomous", { maxGoalsPerDay: 3, maxChainDepth: 2 });
    expect(prompt).toContain("user-facing features");
    expect(prompt).toContain("Do NOT generate work whose primary value is refactoring");
    expect(prompt).toContain("voice speed control");
    expect(prompt).toContain("at most three worthwhile ideas");
    expect(prompt).toContain("Maximum autonomous goals created per UTC day: 3");
    expect(prompt).toContain("Maximum proactive goal chain depth: 2");
    expect(prompt).toContain(AUTONOMOUS_GOAL_MARKER);
  });

  it("converts ideas to goals without leaking the title marker", () => {
    expect(isIdeaTitle("[idea] Voice speed")).toBe(true);
    expect(ideaTitle("Voice speed")).toBe("[idea] Voice speed");
    expect(goalTitle("[idea] Voice speed")).toBe("Voice speed");
  });

  it("reads structured opportunity metadata and preserves lineage on promotion", () => {
    const notes = `${OPPORTUNITY_MARKER}
sourceGoalId=goal-1
depth=2
value=high
effort=low
confidence=high

Add speaking-rate controls to voice settings.`;
    expect(parseOpportunityMetadata(notes)).toEqual({
      sourceGoalId: "goal-1",
      depth: 2,
      value: "high",
      effort: "low",
      confidence: "high",
    });
    const promoted = buildUserPromotedGoalNotes("idea-1", notes);
    expect(promoted).toContain(USER_PROMOTED_GOAL_MARKER);
    expect(promoted).toContain("sourceIdeaId=idea-1");
    expect(promoted).toContain("depth=2");
    expect(visibleWorkNotes(promoted)).toBe("Add speaking-rate controls to voice settings.");
  });

  it("keeps promoted notes within the scratchpad notes limit", () => {
    const notes = `${OPPORTUNITY_MARKER}
sourceGoalId=goal-1
depth=2
value=high
effort=low
confidence=high

${"x".repeat(SCRATCHPAD_NOTES_MAX)}`;
    const promoted = buildUserPromotedGoalNotes("idea-1", notes);
    expect(promoted.length).toBeLessThanOrEqual(SCRATCHPAD_NOTES_MAX);
    expect(promoted).toContain(USER_PROMOTED_GOAL_MARKER);
    expect(promoted).toContain("sourceIdeaId=idea-1");
    expect(promoted).toMatch(/sourceIdeaId=idea-1\ndepth=2$/);

    const autonomous = buildAutonomousPromotedGoalNotes("idea-1", notes);
    expect(autonomous.length).toBeLessThanOrEqual(SCRATCHPAD_NOTES_MAX);
    expect(autonomous).toContain(AUTONOMOUS_GOAL_MARKER);
    expect(autonomous).toContain("sourceIdeaId=idea-1");
    expect(autonomous).toContain("depth=2");
  });

  it("refuses goal-chain depths beyond the absolute autonomy ceiling", () => {
    const notes = `${OPPORTUNITY_MARKER}
sourceGoalId=goal-1
depth=4
value=high
effort=low
confidence=high

Too deep.`;
    expect(exceedsGoalChainDepth(notes)).toBe(true);
    expect(exceedsGoalChainDepth(notes, 3)).toBe(true);
    expect(exceedsGoalChainDepth(notes.replace("depth=4", "depth=3"), 3)).toBe(false);
  });
});
