export const AUTONOMY_ROUTINE_NAME = "Autonomy";
export const AUTONOMY_PROMPT_MARKER = "[rakazo-autonomy:v1]";
export const OPPORTUNITY_MARKER = "[rakazo-opportunity:v1]";
export const AUTONOMOUS_GOAL_MARKER = "[rakazo-autonomous-goal:v1]";
export const USER_PROMOTED_GOAL_MARKER = "[rakazo-user-promoted-goal:v1]";
export const IDEA_PREFIX = "[idea] ";

export type AutonomyMode = "off" | "continue" | "propose" | "autonomous";
export type ActiveAutonomyMode = Exclude<AutonomyMode, "off">;
export type HeartbeatMinutes = 15 | 30 | 60 | 120;
export type MaxAutonomousGoalsPerDay = 1 | 3 | 5;
export type MaxGoalChainDepth = 1 | 2 | 3;

export type AutonomyLimits = {
  maxGoalsPerDay: MaxAutonomousGoalsPerDay;
  maxChainDepth: MaxGoalChainDepth;
};

export type OpportunityMetadata = {
  sourceGoalId: string | null;
  depth: number;
  value: "low" | "medium" | "high" | null;
  effort: "low" | "medium" | "high" | null;
  confidence: "low" | "medium" | "high" | null;
};

export const HEARTBEAT_OPTIONS: HeartbeatMinutes[] = [15, 30, 60, 120];
export const MAX_AUTONOMOUS_GOALS_OPTIONS: MaxAutonomousGoalsPerDay[] = [1, 3, 5];
export const MAX_GOAL_CHAIN_DEPTH_OPTIONS: MaxGoalChainDepth[] = [1, 2, 3];
export const DEFAULT_AUTONOMY_LIMITS: AutonomyLimits = {
  maxGoalsPerDay: 3,
  maxChainDepth: 3,
};

export function autonomyCron(minutes: HeartbeatMinutes): string {
  if (minutes === 60) return "0 * * * *";
  if (minutes === 120) return "0 */2 * * *";
  return `*/${minutes} * * * *`;
}

export function heartbeatFromCrons(crons: string[]): HeartbeatMinutes {
  const cron = crons[0] ?? "";
  if (cron === "*/15 * * * *") return 15;
  if (cron === "0 * * * *") return 60;
  if (cron === "0 */2 * * *") return 120;
  return 30;
}

export function isAutonomyPrompt(prompt: string): boolean {
  return prompt.includes(AUTONOMY_PROMPT_MARKER);
}

export function parseAutonomyMode(prompt: string): ActiveAutonomyMode {
  const match = prompt.match(/^MODE=(continue|propose|autonomous)$/m);
  if (match?.[1] === "continue" || match?.[1] === "autonomous") return match[1];
  return "propose";
}

export function parseAutonomyLimits(prompt: string): AutonomyLimits {
  const maxGoals = Number(prompt.match(/^MAX_AUTONOMOUS_GOALS_PER_DAY=(\d+)$/m)?.[1]);
  const maxDepth = Number(prompt.match(/^MAX_GOAL_CHAIN_DEPTH=(\d+)$/m)?.[1]);
  return {
    maxGoalsPerDay:
      maxGoals === 1 || maxGoals === 5 ? maxGoals : DEFAULT_AUTONOMY_LIMITS.maxGoalsPerDay,
    maxChainDepth:
      maxDepth === 1 || maxDepth === 2 ? maxDepth : DEFAULT_AUTONOMY_LIMITS.maxChainDepth,
  };
}

export function isIdeaTitle(title: string): boolean {
  return title.trimStart().toLowerCase().startsWith(IDEA_PREFIX);
}

export function ideaTitle(title: string): string {
  const clean = title.trim();
  return isIdeaTitle(clean) ? clean : `${IDEA_PREFIX}${clean}`;
}

export function goalTitle(title: string): string {
  const clean = title.trim();
  return isIdeaTitle(clean) ? clean.slice(IDEA_PREFIX.length).trim() : clean;
}

function metadataValue(notes: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = notes.match(new RegExp(`^${escapedKey}=([^\\n]+)$`, "m"));
  return match?.[1]?.trim() || null;
}

function level(value: string | null): OpportunityMetadata["value"] {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

export function parseOpportunityMetadata(notes: string): OpportunityMetadata | null {
  if (!notes.includes(OPPORTUNITY_MARKER)) return null;
  const depth = Number(metadataValue(notes, "depth"));
  const sourceGoalId = metadataValue(notes, "sourceGoalId");
  return {
    sourceGoalId: sourceGoalId && sourceGoalId !== "none" ? sourceGoalId : null,
    depth: Number.isInteger(depth) && depth > 0 ? depth : 1,
    value: level(metadataValue(notes, "value")),
    effort: level(metadataValue(notes, "effort")),
    confidence: level(metadataValue(notes, "confidence")),
  };
}

export function opportunityRationale(notes: string): string {
  const markerIndex = notes.indexOf(OPPORTUNITY_MARKER);
  if (markerIndex < 0) return notes.trim();
  const afterMarker = notes.slice(markerIndex + OPPORTUNITY_MARKER.length);
  const rationaleStart = afterMarker.indexOf("\n\n");
  return rationaleStart < 0 ? "" : afterMarker.slice(rationaleStart + 2).trim();
}

export function buildUserPromotedGoalNotes(itemId: string, notes: string): string {
  const metadata = parseOpportunityMetadata(notes);
  return [
    notes.trim(),
    USER_PROMOTED_GOAL_MARKER,
    `sourceIdeaId=${itemId}`,
    `depth=${metadata?.depth ?? 1}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildAutonomyPrompt(
  mode: ActiveAutonomyMode,
  limits: AutonomyLimits = DEFAULT_AUTONOMY_LIMITS,
): string {
  const modeInstruction =
    mode === "continue"
      ? "If there is no active goal, stop. Do not create or propose new work."
      : mode === "propose"
        ? "When there is no active goal, discover product opportunities and save them as parked ideas. Do not start implementing an idea until the user promotes it to a goal."
        : "When there is no active goal, discover product opportunities, choose the strongest eligible one, promote it to an open goal, and continue working on it.";

  return `${AUTONOMY_PROMPT_MARKER}
MODE=${mode}
MAX_AUTONOMOUS_GOALS_PER_DAY=${limits.maxGoalsPerDay}
MAX_GOAL_CHAIN_DEPTH=${limits.maxChainDepth}

You are running Rakazo's autonomous product loop for this bot.

Durable work model
- Use scratchpad_list with includeDone=true first. Treat non-idea open items as goals.
- Titles beginning with "${IDEA_PREFIX.trim()}" are product ideas, not active goals.
- Use scratchpad_update and scratchpad_complete to keep goal state accurate.
- Use scratchpad_add with status "parked" and a title beginning with "${IDEA_PREFIX.trim()}" for discovered ideas.
- Completed items are history: use them to understand prior work and lineage, not as work to restart.

Goal execution
1. If an open goal exists, continue the highest-value unfinished goal.
2. Before acting, recover the relevant context from the conversation, scratchpad, and bot workspace.
3. Work toward the user-visible outcome, not generic maintenance.
4. Mark a goal done only after its requested outcome is actually complete or clearly delivered.
5. If blocked on user judgment, credentials, approval, or missing information, explain the blocker in the conversation and stop instead of inventing an answer.

Product reflection
After completing a goal, or when no active goal exists, ask: "What product capability would naturally make what was just built more useful?"
- Prefer user-facing features, UX capabilities, meaningful integrations, and sensible automation.
- Good examples: voice speed control after adding voices; voice preview after adding a voice picker; reusable presets after adding configurable voice parameters.
- Do NOT generate work whose primary value is refactoring, formatting, dependency upgrades, tests, documentation, lint cleanup, code style, or speculative rewrites unless the user's original goal was specifically about that area.
- Stay close to the original product intent. Do not drift into unrelated product areas.
- Generate at most three worthwhile ideas per reflection. If there is no strong idea, create nothing and stop.
- Rank ideas by user value first, then confidence, then effort. Do not prefer an easy idea merely because it is easy.
- Every idea must use this notes header exactly, followed by a blank line and a short human-readable rationale:
${OPPORTUNITY_MARKER}
sourceGoalId=<scratchpad goal id or none>
depth=<1 for a user goal extension, otherwise parent depth + 1>
value=<low|medium|high>
effort=<low|medium|high>
confidence=<low|medium|high>

Autonomy policy
${modeInstruction}
- Maximum autonomous goals created per UTC day: ${limits.maxGoalsPerDay}.
- Maximum proactive goal chain depth: ${limits.maxChainDepth}.
- Before promoting an idea autonomously, inspect scratchpad history and count goals created today whose notes contain ${AUTONOMOUS_GOAL_MARKER}. If the daily limit is reached, stop without promoting another idea.
- Never autonomously promote an idea whose depth is greater than ${limits.maxChainDepth}.
- When promoting an idea autonomously, change it to status "open", remove the "${IDEA_PREFIX.trim()}" title prefix, preserve its opportunity metadata, and append:
${AUTONOMOUS_GOAL_MARKER}
sourceIdeaId=<the idea scratchpad id>
depth=<the idea depth>
- A newly autonomous idea must remain a direct extension of the current product area. Never create an endless chain of improvements.
- Respect Rakazo approvals and all existing tool/security boundaries.
- Do not perform destructive or irreversible actions merely to make progress.

Workspace
- Use the bot's persistent workspace for durable working material when useful.
- Keep agent-owned material under .rakazo/work, .rakazo/ideas, and .rakazo/journal where practical; keep project checkouts under projects and finished deliverables under artifacts.
- Create these folders lazily when you actually need them; do not create empty structure just for appearance.
- Keep temporary reasoning out of the workspace; save only useful plans, research, decisions, drafts, or deliverables.

When nothing useful remains, stop cleanly. Do not manufacture work to stay busy.`;
}
