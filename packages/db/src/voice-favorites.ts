import type { Actor, VoiceFavorite } from "@ryvoko/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

export class VoiceFavoriteAlreadyExistsError extends Error {
  constructor() {
    super("That voice is already in favorites");
    this.name = "VoiceFavoriteAlreadyExistsError";
  }
}

export type VoiceFavoriteListOptions = {
  provider?: string;
  query?: string;
};

type VoiceFavoriteRow = {
  id: string;
  spaceId: string;
  provider: string;
  voiceId: string;
  label: string | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
};

function toVoiceFavorite(row: VoiceFavoriteRow): VoiceFavorite {
  return {
    id: row.id,
    spaceId: row.spaceId,
    provider: row.provider,
    voiceId: row.voiceId,
    label: row.label,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function favoriteWhere(actor: Actor, id?: string) {
  return {
    ...(id ? { id } : {}),
    spaceId: actor.spaceId,
    userId: actor.userId,
  };
}

function normalizeLabel(label: string | null | undefined): string | null | undefined {
  if (label === undefined) return undefined;
  if (label === null) return null;
  const normalized = label.trim();
  return normalized.length > 0 ? normalized : null;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

export async function listVoiceFavorites(
  prisma: PrismaClient,
  actor: Actor,
  options: VoiceFavoriteListOptions = {},
): Promise<VoiceFavorite[]> {
  const query = options.query?.trim();
  const rows = await prisma.voiceFavorite.findMany({
    where: {
      ...favoriteWhere(actor),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(query
        ? {
            OR: [
              { voiceId: { contains: query, mode: "insensitive" } },
              { label: { contains: query, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toVoiceFavorite);
}

export async function createVoiceFavorite(
  prisma: PrismaClient,
  actor: Actor,
  input: { provider: string; voiceId: string; label?: string | null },
): Promise<VoiceFavorite> {
  const provider = input.provider.trim();
  const voiceId = input.voiceId.trim();
  const label = normalizeLabel(input.label);
  try {
    // Serialize position allocation the same way space membership writes do.
    const row = await withTransactionRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const aggregate = await tx.voiceFavorite.aggregate({
            where: favoriteWhere(actor),
            _max: { position: true },
          });
          return tx.voiceFavorite.create({
            data: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              provider,
              voiceId,
              label: label ?? null,
              position: (aggregate._max.position ?? -1) + 1,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
    return toVoiceFavorite(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new VoiceFavoriteAlreadyExistsError();
    throw error;
  }
}

export async function updateVoiceFavorite(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    id: string;
    provider?: string;
    voiceId?: string;
    label?: string | null;
  },
): Promise<VoiceFavorite> {
  try {
    const result = await prisma.voiceFavorite.updateMany({
      where: favoriteWhere(actor, input.id),
      data: {
        ...(input.provider === undefined ? {} : { provider: input.provider.trim() }),
        ...(input.voiceId === undefined ? {} : { voiceId: input.voiceId.trim() }),
        ...(input.label === undefined ? {} : { label: normalizeLabel(input.label) }),
      },
    });
    if (result.count === 0) throw new IsolationError();
    const row = await prisma.voiceFavorite.findFirst({
      where: favoriteWhere(actor, input.id),
    });
    if (!row) throw new IsolationError();
    return toVoiceFavorite(row);
  } catch (error) {
    if (error instanceof IsolationError) throw error;
    if (isUniqueViolation(error)) throw new VoiceFavoriteAlreadyExistsError();
    throw error;
  }
}

export async function deleteVoiceFavorite(
  prisma: PrismaClient,
  actor: Actor,
  id: string,
): Promise<{ ok: true }> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.voiceFavorite.findFirst({ where: favoriteWhere(actor, id) });
    if (!existing) throw new IsolationError();
    await tx.voiceFavorite.delete({ where: { id } });
    await tx.voiceFavorite.updateMany({
      where: { ...favoriteWhere(actor), position: { gt: existing.position } },
      data: { position: { decrement: 1 } },
    });
  });
  return { ok: true };
}

export async function reorderVoiceFavorites(
  prisma: PrismaClient,
  actor: Actor,
  favoriteIds: string[],
): Promise<VoiceFavorite[]> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.voiceFavorite.findMany({ where: favoriteWhere(actor) });
    if (rows.length !== favoriteIds.length) throw new IsolationError();
    const knownIds = new Set(rows.map((row) => row.id));
    if (favoriteIds.some((id) => !knownIds.has(id)) || new Set(favoriteIds).size !== rows.length) {
      throw new IsolationError();
    }
    await Promise.all(
      favoriteIds.map((id, position) =>
        tx.voiceFavorite.update({ where: { id }, data: { position } }),
      ),
    );
    const updated = await tx.voiceFavorite.findMany({
      where: favoriteWhere(actor),
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    return updated.map(toVoiceFavorite);
  });
}
