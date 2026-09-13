import {
  AUTONOMOUS_GOAL_MARKER,
  autonomyLimitError,
  countAutonomousGoalsForUtcDay,
  DEFAULT_AUTONOMY_LIMITS,
  ensureAutonomousPromotedGoalNotes,
  isAutonomyPrompt,
  isIntroducingAutonomousGoal,
  parseAutonomyLimits,
  type AutonomyLimits,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

export const SCRATCHPAD_STATUSES = ["open", "parked", "done"] as const;
export type ScratchpadStatus = (typeof SCRATCHPAD_STATUSES)[number];

export const OPEN_SCRATCHPAD_STATUSES: ScratchpadStatus[] = ["open", "parked"];

const TITLE_MAX = 200;
const NOTES_MAX = 4_000;

export type ScratchpadToolDeps = {
  prisma: PrismaClient;
};

export type ScratchpadRow = {
  id: string;
  botId: string;
  title: string;
  status: string;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
};

export function mapScratchpadItem(row: ScratchpadRow) {
  return {
    id: row.id,
    botId: row.botId,
    title: row.title,
    status: coerceScratchpadStatus(row.status),
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function isScratchpadStatus(value: unknown): value is ScratchpadStatus {
  return typeof value === "string" && (SCRATCHPAD_STATUSES as readonly string[]).includes(value);
}

export function coerceScratchpadStatus(value: unknown): ScratchpadStatus {
  return isScratchpadStatus(value) ? value : "open";
}

export async function listScratchpadItems(
  deps: ScratchpadToolDeps,
  input: {
    spaceId: string;
    botId: string;
    status?: ScratchpadStatus;
    includeDone?: boolean;
  },
) {
  const statusFilter = input.status
    ? { status: input.status }
    : input.includeDone
      ? {}
      : { status: { in: OPEN_SCRATCHPAD_STATUSES } };
  const rows = await deps.prisma.scratchpadItem.findMany({
    where: {
      spaceId: input.spaceId,
      botId: input.botId,
      ...statusFilter,
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });
  return rows.map(mapScratchpadItem);
}

async function loadAutonomyLimits(
  deps: ScratchpadToolDeps,
  input: { spaceId: string; botId: string },
): Promise<AutonomyLimits> {
  const routines = await deps.prisma.routine.findMany({
    where: { spaceId: input.spaceId, botId: input.botId },
    select: { prompt: true },
  });
  const autonomy = routines.find((routine) => isAutonomyPrompt(routine.prompt));
  return autonomy ? parseAutonomyLimits(autonomy.prompt) : DEFAULT_AUTONOMY_LIMITS;
}

async function countAutonomousGoalsToday(
  deps: ScratchpadToolDeps,
  input: { spaceId: string; botId: string; excludeItemId?: string },
  now: Date = new Date(),
): Promise<number> {
  const items = await deps.prisma.scratchpadItem.findMany({
    where: {
      spaceId: input.spaceId,
      botId: input.botId,
      notes: { contains: AUTONOMOUS_GOAL_MARKER },
      ...(input.excludeItemId ? { id: { not: input.excludeItemId } } : {}),
    },
    select: { notes: true, createdAt: true },
  });
  return countAutonomousGoalsForUtcDay(items, now);
}

async function refuseOrNormalizeAutonomousGoal(
  deps: ScratchpadToolDeps,
  input: {
    spaceId: string;
    botId: string;
    itemId?: string;
    title: string;
    status: ScratchpadStatus;
    notes: string;
    previousTitle?: string;
    previousStatus?: string;
    previousNotes?: string;
    now?: Date;
  },
): Promise<{ error: string } | { notes: string }> {
  if (
    !isIntroducingAutonomousGoal({
      title: input.title,
      status: input.status,
      notes: input.notes,
      previousTitle: input.previousTitle,
      previousStatus: input.previousStatus,
      previousNotes: input.previousNotes,
    })
  ) {
    return { notes: input.notes };
  }

  const now = input.now ?? new Date();
  const limits = await loadAutonomyLimits(deps, {
    spaceId: input.spaceId,
    botId: input.botId,
  });
  const autonomousGoalsToday = await countAutonomousGoalsToday(
    deps,
    { spaceId: input.spaceId, botId: input.botId, excludeItemId: input.itemId },
    now,
  );
  const error = autonomyLimitError({
    notes: input.notes,
    limits,
    autonomousGoalsToday,
  });
  if (error) return { error };

  // For creates the row id is not known yet; stamp a temporary id then rewrite after insert.
  return {
    notes: ensureAutonomousPromotedGoalNotes(input.itemId ?? "pending", input.notes, now),
  };
}

export async function addScratchpadItemFromTool(
  deps: ScratchpadToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    title: string;
    status?: string;
    notes?: string;
  },
) {
  const title = input.title.trim();
  if (!title) return { error: "title is required." };
  if (title.length > TITLE_MAX) return { error: `title must be at most ${TITLE_MAX} characters.` };
  let notes = (input.notes ?? "").trim();
  if (notes.length > NOTES_MAX) return { error: `notes must be at most ${NOTES_MAX} characters.` };

  let status: ScratchpadStatus = "open";
  if (input.status !== undefined) {
    if (!isScratchpadStatus(input.status)) {
      return { error: "status must be open, parked, or done." };
    }
    status = input.status;
  }

  const gated = await refuseOrNormalizeAutonomousGoal(deps, {
    spaceId: input.spaceId,
    botId: input.botId,
    title,
    status,
    notes,
  });
  if ("error" in gated) return gated;
  notes = gated.notes;
  if (notes.length > NOTES_MAX) return { error: `notes must be at most ${NOTES_MAX} characters.` };

  const row = await deps.prisma.scratchpadItem.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
      title,
      status,
      notes,
    },
  });

  if (notes.includes("sourceIdeaId=pending")) {
    const normalized = ensureAutonomousPromotedGoalNotes(row.id, (input.notes ?? "").trim());
    if (normalized !== notes && normalized.length <= NOTES_MAX) {
      const updated = await deps.prisma.scratchpadItem.update({
        where: { id: row.id },
        data: { notes: normalized },
      });
      return { item: mapScratchpadItem(updated) };
    }
  }

  return { item: mapScratchpadItem(row) };
}

export async function updateScratchpadItemFromTool(
  deps: ScratchpadToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    itemId: string;
    title?: string;
    status?: string;
    notes?: string;
  },
) {
  const itemId = input.itemId.trim();
  if (!itemId) return { error: "itemId is required." };

  const existing = await deps.prisma.scratchpadItem.findFirst({
    where: {
      id: itemId,
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
    },
  });
  if (!existing) return { error: "Scratchpad item not found." };

  const data: { title?: string; status?: string; notes?: string } = {};
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) return { error: "title cannot be empty." };
    if (title.length > TITLE_MAX)
      return { error: `title must be at most ${TITLE_MAX} characters.` };
    data.title = title;
  }
  if (input.status !== undefined) {
    if (!isScratchpadStatus(input.status)) {
      return { error: "status must be open, parked, or done." };
    }
    data.status = input.status;
  }
  if (input.notes !== undefined) {
    const notes = input.notes.trim();
    if (notes.length > NOTES_MAX)
      return { error: `notes must be at most ${NOTES_MAX} characters.` };
    data.notes = notes;
  }
  if (Object.keys(data).length === 0) {
    return { error: "Provide title, status, and/or notes to update." };
  }

  const nextTitle = data.title ?? existing.title;
  const nextStatus = coerceScratchpadStatus(data.status ?? existing.status);
  const nextNotes = data.notes ?? existing.notes;
  const gated = await refuseOrNormalizeAutonomousGoal(deps, {
    spaceId: input.spaceId,
    botId: input.botId,
    itemId: existing.id,
    title: nextTitle,
    status: nextStatus,
    notes: nextNotes,
    previousTitle: existing.title,
    previousStatus: existing.status,
    previousNotes: existing.notes,
  });
  if ("error" in gated) return gated;
  if (gated.notes !== nextNotes) {
    if (gated.notes.length > NOTES_MAX) {
      return { error: `notes must be at most ${NOTES_MAX} characters.` };
    }
    data.notes = gated.notes;
  }

  const row = await deps.prisma.scratchpadItem.update({
    where: { id: existing.id },
    data,
  });
  return { item: mapScratchpadItem(row) };
}

export async function completeScratchpadItemFromTool(
  deps: ScratchpadToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    itemId: string;
  },
) {
  return updateScratchpadItemFromTool(deps, {
    ...input,
    status: "done",
  });
}

export async function removeScratchpadItemFromTool(
  deps: ScratchpadToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    itemId: string;
  },
) {
  const itemId = input.itemId.trim();
  if (!itemId) return { error: "itemId is required." };

  const existing = await deps.prisma.scratchpadItem.findFirst({
    where: {
      id: itemId,
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
    },
  });
  if (!existing) return { error: "Scratchpad item not found." };

  await deps.prisma.scratchpadItem.delete({ where: { id: existing.id } });
  return { ok: true as const, itemId: existing.id, title: existing.title };
}

export async function listScratchpadItemsFromTool(
  deps: ScratchpadToolDeps,
  input: {
    spaceId: string;
    botId: string;
    includeDone?: boolean;
  },
) {
  const items = await listScratchpadItems(deps, {
    spaceId: input.spaceId,
    botId: input.botId,
    includeDone: input.includeDone,
  });
  return { items };
}
