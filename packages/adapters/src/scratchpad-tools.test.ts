import { AUTONOMOUS_GOAL_MARKER, AUTONOMY_PROMPT_MARKER, OPPORTUNITY_MARKER } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import {
  addScratchpadItemFromTool,
  completeScratchpadItemFromTool,
  listScratchpadItems,
  listScratchpadItemsFromTool,
  removeScratchpadItemFromTool,
  updateScratchpadItemFromTool,
} from "./scratchpad-tools.js";

describe("scratchpad tools store", () => {
  it("lists open and parked items by default and omits done", async () => {
    const findMany = vi.fn(async () => [
      row({ id: "1", title: "Open", status: "open" }),
      row({ id: "2", title: "Parked", status: "parked" }),
    ]);
    const prisma = {
      scratchpadItem: { findMany },
    };

    const items = await listScratchpadItems(
      { prisma: prisma as never },
      { spaceId: "ws", botId: "bot" },
    );

    expect(findMany).toHaveBeenCalledWith({
      where: { spaceId: "ws", botId: "bot", status: { in: ["open", "parked"] } },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
    expect(items).toEqual([
      expect.objectContaining({ id: "1", title: "Open", status: "open" }),
      expect.objectContaining({ id: "2", title: "Parked", status: "parked" }),
    ]);
  });

  it("adds an item with trimmed title and default open status", async () => {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
      row({
        id: "new",
        title: String(data.title),
        status: String(data.status),
        notes: String(data.notes),
      }),
    );
    const prisma = { scratchpadItem: { create } };

    const result = await addScratchpadItemFromTool(
      { prisma: prisma as never },
      {
        spaceId: "ws",
        botId: "bot",
        userId: "user",
        title: "  Ship PR  ",
        notes: " after review ",
      },
    );

    expect(create).toHaveBeenCalledWith({
      data: {
        spaceId: "ws",
        botId: "bot",
        userId: "user",
        title: "Ship PR",
        status: "open",
        notes: "after review",
      },
    });
    expect(result).toEqual({
      item: expect.objectContaining({ id: "new", title: "Ship PR", status: "open" }),
    });
  });

  it("rejects invalid status on add", async () => {
    const result = await addScratchpadItemFromTool(
      { prisma: { scratchpadItem: { create: vi.fn() } } as never },
      {
        spaceId: "ws",
        botId: "bot",
        userId: "user",
        title: "Nope",
        status: "later",
      },
    );
    expect(result).toEqual({ error: "status must be open, parked, or done." });
  });

  it("updates, completes, and removes scoped items", async () => {
    const existing = row({ id: "item-1", title: "Draft", status: "open" });
    const findFirst = vi.fn(async () => existing);
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
      row({ ...existing, ...data, status: String(data.status ?? existing.status) }),
    );
    const del = vi.fn(async () => existing);
    const prisma = {
      scratchpadItem: { findFirst, update, delete: del },
    };

    const updated = await updateScratchpadItemFromTool(
      { prisma: prisma as never },
      {
        spaceId: "ws",
        botId: "bot",
        userId: "user",
        itemId: "item-1",
        title: "Draft v2",
        status: "parked",
      },
    );
    expect(updated).toEqual({
      item: expect.objectContaining({ title: "Draft v2", status: "parked" }),
    });

    const completed = await completeScratchpadItemFromTool(
      { prisma: prisma as never },
      { spaceId: "ws", botId: "bot", userId: "user", itemId: "item-1" },
    );
    expect(completed).toEqual({
      item: expect.objectContaining({ status: "done" }),
    });

    const removed = await removeScratchpadItemFromTool(
      { prisma: prisma as never },
      { spaceId: "ws", botId: "bot", userId: "user", itemId: "item-1" },
    );
    expect(removed).toEqual({ ok: true, itemId: "item-1", title: "Draft" });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: "item-1",
        spaceId: "ws",
        botId: "bot",
        userId: "user",
      },
    });
  });

  it("returns not found when item is outside the bot scope", async () => {
    const prisma = {
      scratchpadItem: { findFirst: vi.fn(async () => null) },
    };
    await expect(
      updateScratchpadItemFromTool(
        { prisma: prisma as never },
        {
          spaceId: "ws",
          botId: "bot",
          userId: "user",
          itemId: "missing",
          title: "x",
        },
      ),
    ).resolves.toEqual({ error: "Scratchpad item not found." });
  });

  it("lists via tool wrapper", async () => {
    const findMany = vi.fn(async () => [row({ id: "1", title: "Open", status: "open" })]);
    const result = await listScratchpadItemsFromTool(
      { prisma: { scratchpadItem: { findMany } } as never },
      { spaceId: "ws", botId: "bot" },
    );
    expect(result.items).toHaveLength(1);
  });

  it("refuses autonomous create when the daily goal limit is reached", async () => {
    const create = vi.fn();
    const today = new Date();
    const autonomousAt = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 8, 0, 0),
    ).toISOString();
    const prisma = {
      routine: {
        findMany: vi.fn(async () => [
          { prompt: autonomyPrompt({ maxGoalsPerDay: 1, maxChainDepth: 3 }) },
        ]),
      },
      scratchpadItem: {
        findMany: vi.fn(async () => [
          row({
            id: "existing",
            title: "Already autonomous",
            status: "open",
            notes: `${AUTONOMOUS_GOAL_MARKER}\nsourceIdeaId=old\ndepth=1\nautonomousAt=${autonomousAt}`,
          }),
        ]),
        create,
      },
    };

    const result = await addScratchpadItemFromTool(
      { prisma: prisma as never },
      {
        spaceId: "ws",
        botId: "bot",
        userId: "user",
        title: "Another autonomous goal",
        status: "open",
        notes: `${AUTONOMOUS_GOAL_MARKER}\ndepth=1`,
      },
    );

    expect(result).toEqual({ error: "Autonomy daily goal limit is 1." });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses autonomous promote when idea depth exceeds the chain limit", async () => {
    const existing = row({
      id: "idea-1",
      title: "[idea] Voice speed",
      status: "parked",
      notes: `${OPPORTUNITY_MARKER}\nsourceGoalId=goal-1\ndepth=3\nvalue=high\neffort=low\nconfidence=high\n\nAdd speed.`,
    });
    const update = vi.fn();
    const prisma = {
      routine: {
        findMany: vi.fn(async () => [
          { prompt: autonomyPrompt({ maxGoalsPerDay: 5, maxChainDepth: 2 }) },
        ]),
      },
      scratchpadItem: {
        findFirst: vi.fn(async () => existing),
        findMany: vi.fn(async () => []),
        update,
      },
    };

    const result = await updateScratchpadItemFromTool(
      { prisma: prisma as never },
      {
        spaceId: "ws",
        botId: "bot",
        userId: "user",
        itemId: "idea-1",
        title: "Voice speed",
        status: "open",
        notes: existing.notes,
      },
    );

    expect(result).toEqual({ error: "Autonomy goal chain depth limit is 2." });
    expect(update).not.toHaveBeenCalled();
  });

  it("stamps autonomous lineage when promoting an idea under the limits", async () => {
    const existing = row({
      id: "idea-1",
      title: "[idea] Voice preview",
      status: "parked",
      notes: `${OPPORTUNITY_MARKER}\nsourceGoalId=goal-1\ndepth=1\nvalue=high\neffort=low\nconfidence=high\n\nAdd preview.`,
    });
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
      row({
        ...existing,
        title: String(data.title ?? existing.title),
        status: String(data.status ?? existing.status),
        notes: String(data.notes ?? existing.notes),
      }),
    );
    const prisma = {
      routine: {
        findMany: vi.fn(async () => [
          { prompt: autonomyPrompt({ maxGoalsPerDay: 3, maxChainDepth: 2 }) },
        ]),
      },
      scratchpadItem: {
        findFirst: vi.fn(async () => existing),
        findMany: vi.fn(async () => []),
        update,
      },
    };

    const result = await updateScratchpadItemFromTool(
      { prisma: prisma as never },
      {
        spaceId: "ws",
        botId: "bot",
        userId: "user",
        itemId: "idea-1",
        title: "Voice preview",
        status: "open",
      },
    );

    expect(result).toEqual({
      item: expect.objectContaining({
        title: "Voice preview",
        status: "open",
        notes: expect.stringContaining(AUTONOMOUS_GOAL_MARKER),
      }),
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "idea-1" },
      data: expect.objectContaining({
        title: "Voice preview",
        status: "open",
        notes: expect.stringContaining("autonomousAt="),
      }),
    });
  });
});

function autonomyPrompt(limits: { maxGoalsPerDay: number; maxChainDepth: number }) {
  return `${AUTONOMY_PROMPT_MARKER}
MODE=autonomous
MAX_AUTONOMOUS_GOALS_PER_DAY=${limits.maxGoalsPerDay}
MAX_GOAL_CHAIN_DEPTH=${limits.maxChainDepth}
`;
}

function row(partial: {
  id: string;
  title: string;
  status: string;
  notes?: string;
  botId?: string;
}) {
  const now = new Date("2026-08-25T12:00:00.000Z");
  return {
    id: partial.id,
    botId: partial.botId ?? "bot",
    title: partial.title,
    status: partial.status,
    notes: partial.notes ?? "",
    createdAt: now,
    updatedAt: now,
  };
}
