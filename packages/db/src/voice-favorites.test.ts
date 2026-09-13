import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";
import {
  createVoiceFavorite,
  deleteVoiceFavorite,
  listVoiceFavorites,
  reorderVoiceFavorites,
  updateVoiceFavorite,
} from "./voice-favorites.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "test@example.com",
  isDeploymentOwner: false,
};

function row(id: string, position: number) {
  return {
    id,
    spaceId: actor.spaceId,
    userId: actor.userId,
    provider: "fish-audio",
    voiceId: `${id}-voice`,
    label: `${id} label`,
    position,
    createdAt: new Date("2026-09-12T00:00:00.000Z"),
    updatedAt: new Date("2026-09-12T00:00:00.000Z"),
  };
}

function db(overrides: Record<string, unknown> = {}) {
  const voiceFavorite = {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn(),
    aggregate: vi.fn().mockResolvedValue({ _max: { position: null } }),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    updateMany: vi.fn(),
    ...overrides,
  };
  const prisma = {
    voiceFavorite,
    $transaction: vi.fn(async (run: (tx: typeof prisma) => unknown) => run(prisma)),
  };
  return prisma as unknown as PrismaClient;
}

describe("voice favorites", () => {
  it("lists only the acting user's favorites in the active space", async () => {
    const prisma = db({ findMany: vi.fn().mockResolvedValue([row("fav-1", 0)]) });

    await expect(listVoiceFavorites(prisma, actor, { provider: "fish-audio" })).resolves.toEqual([
      expect.objectContaining({ id: "fav-1", spaceId: "space-1" }),
    ]);
    expect(prisma.voiceFavorite.findMany).toHaveBeenCalledWith({
      where: { spaceId: "space-1", userId: "user-1", provider: "fish-audio" },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
  });

  it("appends a new favorite after the current scope and normalizes labels", async () => {
    const created = row("fav-2", 3);
    const prisma = db({
      aggregate: vi.fn().mockResolvedValue({ _max: { position: 2 } }),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...created, ...data })),
    });

    await expect(
      createVoiceFavorite(prisma, actor, {
        provider: " fish-audio ",
        voiceId: " voice-2 ",
        label: "  French voice  ",
      }),
    ).resolves.toMatchObject({ id: "fav-2", label: "French voice" });
    expect(prisma.voiceFavorite.create).toHaveBeenCalledWith({
      data: {
        spaceId: "space-1",
        userId: "user-1",
        provider: "fish-audio",
        voiceId: "voice-2",
        label: "French voice",
        position: 3,
      },
    });
  });

  it("rejects updates for favorites outside the actor scope", async () => {
    const prisma = db({ findFirst: vi.fn().mockResolvedValue(null) });

    await expect(
      updateVoiceFavorite(prisma, actor, { id: "other-favorite", label: "Nope" }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(prisma.voiceFavorite.update).not.toHaveBeenCalled();
  });

  it("requires a complete authorized set when reordering", async () => {
    const prisma = db({
      findMany: vi.fn().mockResolvedValue([row("fav-1", 0), row("fav-2", 1)]),
    });

    await expect(reorderVoiceFavorites(prisma, actor, ["fav-1"])).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(prisma.voiceFavorite.update).not.toHaveBeenCalled();
  });

  it("deletes only an authorized favorite and closes the position gap", async () => {
    const prisma = db({ findFirst: vi.fn().mockResolvedValue(row("fav-1", 1)) });

    await expect(deleteVoiceFavorite(prisma, actor, "fav-1")).resolves.toEqual({ ok: true });
    expect(prisma.voiceFavorite.delete).toHaveBeenCalledWith({ where: { id: "fav-1" } });
    expect(prisma.voiceFavorite.updateMany).toHaveBeenCalledWith({
      where: { spaceId: "space-1", userId: "user-1", position: { gt: 1 } },
      data: { position: { decrement: 1 } },
    });
  });
});
