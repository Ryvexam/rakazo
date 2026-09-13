import { ORPCError } from "@orpc/server";
import type { AdapterContext } from "@ryvoko/adapter-kit";
import {
  createVoiceProvider,
  type EncryptedSecretStore,
  isVoiceProviderId,
  listVoiceCatalog,
  MAX_SPEAK_CHARS,
  MAX_TRANSCRIBE_BYTES,
  NoVoiceConfigured,
  voiceCatalogEntry,
} from "@ryvoko/adapters";
import type { Actor, VoiceCredential, VoiceInfo, VoiceStatus } from "@ryvoko/contracts";
import { toUtterances } from "@ryvoko/core";
import {
  deleteUnreferencedCredentialSecret,
  findDefaultVoiceCredential,
  findVoiceCredential,
  IsolationError,
  newestVoiceCredentialOrder,
  Prisma,
  type PrismaClient,
  selectSpaceVoicePreference,
} from "@ryvoko/db";
import type { Context, Hono } from "hono";
import { readBoundedBody } from "./http-body.js";
import { withSerializableRetry } from "./serializable-retry.js";

export interface VoiceDeps {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
}

export { listVoiceCatalog };

const SPEAK_TIMEOUT_MS = 60_000;
export const MAX_SPEAK_REQUEST_BYTES = 16 * 1024;
export const MAX_TRANSCRIBE_REQUEST_BYTES = 4 * Math.ceil(MAX_TRANSCRIBE_BYTES / 3) + 1024;

/** Filter and page a full listVoices catalog for providers without searchVoices. */
export function pageListedVoices(
  items: VoiceInfo[],
  options: { query?: string; page: number; pageSize: number; language?: string },
): { items: VoiceInfo[]; nextPage?: number } {
  const query = options.query?.trim().toLowerCase();
  const language = options.language?.trim().toLowerCase();
  let filtered = items;
  if (query) {
    filtered = filtered.filter((voice) => {
      const haystack = [voice.id, voice.label, voice.description, voice.author?.name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }
  if (language) {
    filtered = filtered.filter((voice) =>
      voice.languages?.some((entry) => entry.toLowerCase().includes(language)),
    );
  }
  const start = (options.page - 1) * options.pageSize;
  const pageItems = filtered.slice(start, start + options.pageSize);
  const nextPage = start + options.pageSize < filtered.length ? options.page + 1 : undefined;
  return nextPage === undefined ? { items: pageItems } : { items: pageItems, nextPage };
}

/** Keep a prior label only when reconnecting without changing the voice id. */
export function resolvePersistedVoiceLabel(input: {
  explicitVoiceId: string;
  lookedUpLabel: string | null;
  previousVoiceId?: string;
  previousVoiceLabel?: string | null;
}): string | null {
  const changed =
    Boolean(input.explicitVoiceId) && input.explicitVoiceId !== (input.previousVoiceId ?? "");
  if (changed) return input.lookedUpLabel;
  return input.lookedUpLabel ?? input.previousVoiceLabel ?? null;
}

export function voiceContext(actor: Actor, signal?: AbortSignal): AdapterContext {
  return {
    operationId: "voice",
    traceId: "voice",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: signal ?? new AbortController().signal,
  };
}

export function catalogEntry(provider: string) {
  return voiceCatalogEntry(provider);
}

/** Resolve a persisted model to the provider default without forwarding stale values. */
function configuredSynthesisModel(provider: string, modelId: string): string {
  const entry = catalogEntry(provider);
  if (!entry?.synthesisModels?.length) return "";
  return entry.synthesisModels.some((model) => model.id === modelId)
    ? modelId
    : (entry.defaultSynthesisModelId ?? entry.synthesisModels[0]?.id ?? "");
}

/** Validate an explicitly requested synthesis model against the provider catalog. */
export function validateVoiceSynthesisModel(
  provider: string,
  modelId: string | undefined,
): string | undefined {
  if (modelId === undefined) return undefined;
  const selected = modelId.trim();
  const entry = catalogEntry(provider);
  if (!entry?.synthesisModels?.some((model) => model.id === selected)) {
    throw new ORPCError("BAD_REQUEST", { message: "Unknown voice synthesis model." });
  }
  return selected;
}

export function toVoiceStatus(
  cred: { provider: string; voiceId: string; modelId: string; voiceLabel?: string | null } | null,
): VoiceStatus {
  const entry = cred ? catalogEntry(cred.provider) : undefined;
  return {
    configured: Boolean(cred),
    ready: Boolean(cred?.voiceId),
    transcribe: Boolean(entry?.transcribe && cred),
    provider: cred?.provider ?? null,
    voiceId: cred?.voiceId ?? "",
    modelId: cred ? configuredSynthesisModel(cred.provider, cred.modelId) : "",
    voiceLabel: cred?.voiceLabel ?? null,
  };
}

export function toVoiceCredential(row: {
  id: string;
  provider: string;
  isDefault: boolean;
  voiceId: string;
  modelId: string;
  voiceLabel?: string | null;
}): VoiceCredential {
  return {
    id: row.id,
    provider: row.provider,
    hasKey: true,
    isDefault: row.isDefault,
    voiceId: row.voiceId,
    modelId: configuredSynthesisModel(row.provider, row.modelId),
    voiceLabel: row.voiceLabel ?? null,
    transcribe: Boolean(catalogEntry(row.provider)?.transcribe),
  };
}

export async function loadDefaultVoiceCredential(deps: VoiceDeps, actor: Actor) {
  return loadVoiceCredential(deps, actor);
}

export async function loadVoiceCredential(deps: VoiceDeps, actor: Actor, provider?: string) {
  const cred = provider
    ? await findVoiceCredential(deps.prisma, actor, provider)
    : await findDefaultVoiceCredential(deps.prisma, actor);
  if (!cred) return null;
  const secret = await deps.prisma.secret.findFirst({
    where: { id: cred.secretId, userId: actor.userId, spaceId: null },
  });
  if (!secret) return null;
  return { cred, apiKey: deps.secrets.load(secret.ciphertext, secret.id) };
}

export async function resolveVoiceTarget(
  deps: VoiceDeps,
  actor: Actor,
  input: { botId?: string; voiceId?: string },
) {
  let botVoice: {
    voiceId: string | null;
    voiceProvider: string | null;
    voiceModelId: string | null;
    voiceLabel: string | null;
  } | null = null;
  if (input.botId) {
    const bot = await deps.prisma.bot.findFirst({
      where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId },
      select: { voiceId: true, voiceProvider: true, voiceModelId: true, voiceLabel: true },
    });
    if (!bot) throw new IsolationError();
    botVoice = bot;
  }
  const loaded = await loadVoiceCredential(deps, actor, botVoice?.voiceProvider ?? undefined);
  if (!loaded) throw new NoVoiceConfigured("key");
  const voiceId = input.voiceId || botVoice?.voiceId || loaded.cred.voiceId;
  if (!voiceId) throw new NoVoiceConfigured("voice");
  return {
    ...loaded,
    voiceId,
    voiceLabel: botVoice?.voiceLabel ?? loaded.cred.voiceLabel,
    modelId: configuredSynthesisModel(
      loaded.cred.provider,
      botVoice?.voiceModelId ?? loaded.cred.modelId,
    ),
  };
}

export async function persistVoiceCredential(
  deps: VoiceDeps,
  actor: Actor,
  input: {
    provider: string;
    plaintext: string;
    voiceId?: string;
    modelId?: string;
    signal?: AbortSignal;
  },
): Promise<VoiceCredential> {
  if (!isVoiceProviderId(input.provider)) {
    throw new ORPCError("BAD_REQUEST", { message: "Unknown voice provider." });
  }
  const provider = createVoiceProvider(input.provider);
  const requestedModelId = validateVoiceSynthesisModel(input.provider, input.modelId);
  const verified = await provider.verify(input.plaintext, voiceContext(actor, input.signal));
  if (!verified.ok) {
    throw new ORPCError("BAD_REQUEST", { message: verified.message ?? "That key was rejected." });
  }
  let voiceId = input.voiceId?.trim() ?? "";
  let voiceLabel: string | null = null;
  if (!voiceId) {
    const voices = await provider.listVoices(input.plaintext, voiceContext(actor, input.signal));
    voiceId = voices[0]?.id ?? "";
    voiceLabel = voices[0]?.label ?? null;
  }
  const stored = await deps.secrets.put(input.plaintext, voiceContext(actor, input.signal));
  const cred = await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const existing = await tx.userVoiceCredential.findFirst({
          where: { userId: actor.userId, provider: input.provider },
          orderBy: newestVoiceCredentialOrder,
        });
        const secret = await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            spaceId: null,
            kind: "voice",
            ciphertext: stored.ciphertext,
          },
        });
        const credential = !existing
          ? await tx.userVoiceCredential.create({
              data: {
                userId: actor.userId,
                provider: input.provider,
                secretId: secret.id,
              },
            })
          : await tx.userVoiceCredential.update({
              where: { id: existing.id },
              data: { secretId: secret.id },
            });
        const previousPreference = existing
          ? await tx.spaceVoicePreference.findUnique({
              where: {
                spaceId_userId_credentialId: {
                  spaceId: actor.spaceId,
                  userId: actor.userId,
                  credentialId: existing.id,
                },
              },
            })
          : null;
        const selectedVoiceId = voiceId || previousPreference?.voiceId || "";
        const selectedVoiceLabel = resolvePersistedVoiceLabel({
          explicitVoiceId: input.voiceId?.trim() ?? "",
          lookedUpLabel: voiceLabel,
          previousVoiceId: previousPreference?.voiceId,
          previousVoiceLabel: previousPreference?.voiceLabel,
        });
        const selectedModelId =
          requestedModelId ??
          previousPreference?.modelId ??
          configuredSynthesisModel(input.provider, "");
        await selectSpaceVoicePreference(
          tx,
          actor,
          credential.id,
          selectedVoiceId,
          selectedModelId,
          selectedVoiceLabel,
        );
        if (existing) {
          await deleteUnreferencedCredentialSecret(tx, {
            credentialKind: "voice",
            credentialId: existing.id,
            secretId: existing.secretId,
          });
        }
        return {
          ...credential,
          isDefault: true,
          voiceId: selectedVoiceId,
          modelId: selectedModelId,
          voiceLabel: selectedVoiceLabel,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return toVoiceCredential(cred);
}

export async function prepareVoice(
  deps: VoiceDeps,
  actor: Actor,
  input: { text: string; voiceId?: string; botId?: string },
) {
  try {
    await resolveVoiceTarget(deps, actor, input);
  } catch (error) {
    if (error instanceof NoVoiceConfigured) {
      return { ready: false, utterances: [] as string[] };
    }
    throw error;
  }
  return { ready: true, utterances: toUtterances(input.text) };
}

export async function synthesizeVoice(
  deps: VoiceDeps,
  actor: Actor,
  input: { text: string; voiceId?: string; botId?: string; signal?: AbortSignal },
) {
  const target = await resolveVoiceTarget(deps, actor, input);
  const text = input.text.trim();
  if (!text) throw new ORPCError("BAD_REQUEST", { message: "Nothing to speak." });
  if (text.length > MAX_SPEAK_CHARS) {
    throw new ORPCError("BAD_REQUEST", { message: "That utterance is too long to speak." });
  }
  const provider = createVoiceProvider(target.cred.provider);
  return provider.synthesize(
    {
      text,
      voiceId: target.voiceId,
      modelId: target.modelId,
      apiKey: target.apiKey,
      signal: input.signal,
    },
    voiceContext(actor, input.signal),
  );
}

export async function transcribeVoice(
  deps: VoiceDeps,
  actor: Actor,
  input: { audio: Uint8Array; mimeType: string; signal?: AbortSignal },
) {
  const loaded = await loadDefaultVoiceCredential(deps, actor);
  if (!loaded) throw new NoVoiceConfigured("key");
  const provider = createVoiceProvider(loaded.cred.provider);
  if (!provider.transcribe) {
    throw new ORPCError("BAD_REQUEST", {
      message: "This voice provider does not transcribe audio. Use on-device dictation instead.",
    });
  }
  if (input.audio.byteLength === 0 || input.audio.byteLength > MAX_TRANSCRIBE_BYTES) {
    throw new ORPCError("BAD_REQUEST", { message: "That recording is empty or too large." });
  }
  return provider.transcribe(
    {
      audio: input.audio,
      mimeType: input.mimeType || "audio/webm",
      apiKey: loaded.apiKey,
      signal: input.signal,
    },
    voiceContext(actor, input.signal),
  );
}

export function mountVoiceHttpRoutes(
  app: Hono,
  deps: VoiceDeps,
  authenticate: (c: Context) => Promise<Actor | null>,
) {
  app.post("/api/voice/speak", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const raw = await readBoundedBody(c.req.raw, MAX_SPEAK_REQUEST_BYTES);
    if (raw === null) return c.json({ error: "Request body is too large." }, 413);
    const body = parseVoiceRequestBody(raw);
    try {
      const clip = await synthesizeVoice(deps, actor, {
        text: String((body as { text?: unknown }).text ?? ""),
        voiceId: optionalString((body as { voiceId?: unknown }).voiceId),
        botId: optionalString((body as { botId?: unknown }).botId),
        signal: AbortSignal.any(
          [c.req.raw.signal, AbortSignal.timeout(SPEAK_TIMEOUT_MS)].filter(
            Boolean,
          ) as AbortSignal[],
        ),
      });
      // Copy into a fresh ArrayBuffer-backed view: DOM-lib BodyInit rejects
      // Uint8Array<ArrayBufferLike> since TS 5.7.
      return new Response(new Uint8Array(clip.bytes), {
        headers: {
          "content-type": clip.mimeType,
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      return voiceHttpError(c, error);
    }
  });

  app.post("/api/voice/transcribe", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const raw = await readBoundedBody(c.req.raw, MAX_TRANSCRIBE_REQUEST_BYTES);
    if (raw === null) return c.json({ error: "Request body is too large." }, 413);
    const body = parseVoiceRequestBody(raw);
    const audioBase64 = String((body as { audioBase64?: unknown }).audioBase64 ?? "");
    try {
      const audio = decodeAudioBase64(audioBase64);
      const result = await transcribeVoice(deps, actor, {
        audio,
        mimeType: String((body as { mimeType?: unknown }).mimeType ?? "audio/webm"),
        signal: c.req.raw.signal,
      });
      return c.json({ text: result.text });
    } catch (error) {
      return voiceHttpError(c, error);
    }
  });
}

function parseVoiceRequestBody(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function decodeAudioBase64(value: string): Uint8Array {
  if (!value.trim()) throw new ORPCError("BAD_REQUEST", { message: "Recording is empty." });
  try {
    return new Uint8Array(Buffer.from(value, "base64"));
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: "Recording is not valid audio." });
  }
}

function voiceHttpError(c: Context, error: unknown) {
  if (error instanceof IsolationError) {
    return c.json({ error: "Resource not found" }, 404);
  }
  if (error instanceof NoVoiceConfigured) {
    return c.json({ error: error.message }, 409);
  }
  if (error instanceof ORPCError) {
    const code = String(error.code ?? "BAD_REQUEST");
    const status =
      code === "UNAUTHORIZED" ? 401 : code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : 400;
    return c.json({ error: error.message }, status);
  }
  const message = error instanceof Error ? error.message : "Voice request failed.";
  return c.json({ error: message }, 502);
}
