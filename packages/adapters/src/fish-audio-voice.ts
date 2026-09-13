import type {
  AdapterContext,
  AdapterDescriptor,
  SpeechClip,
  VoiceCapabilities,
  VoiceCatalogPage,
  VoiceCatalogQuery,
  VoiceInfo,
  VoiceProvider,
  VoiceSynthesizeRequest,
  VoiceTranscribeRequest,
  VoiceVerifyResult,
} from "@rakazo/adapter-kit";
import {
  readVoiceAudio,
  readVoiceJson,
  requireOk,
  speechUploadName,
  voiceDeadline,
  voiceHttpError,
  voiceUnreachable,
} from "./voice-http.js";

const API = "https://api.fish.audio";
const MODEL_PAGE_SIZE = 100;
const SEARCH_DEFAULT_PAGE_SIZE = 30;
const SEARCH_MAX_PAGE_SIZE = 50;
const SEARCH_MAX_PAGE = 10_000;
const SEARCH_MAX_QUERY_LENGTH = 200;
/** Top-scored public voices for the picker — not a full catalog crawl. */
const PUBLIC_MODEL_PAGES = 5;
/** User-owned libraries are smaller; still hard-capped. */
const OWN_MODEL_PAGES = 20;
const LIST_VOICES_DEADLINE_MS = 20_000;

export const FISH_AUDIO_DEFAULT_TTS_MODEL = "s2.1-pro";
export const FISH_AUDIO_TTS_MODELS = [
  {
    id: "s2.1-pro",
    label: "S2.1 Pro",
    description: "Recommended for production",
  },
  {
    id: "s2.1-pro-free",
    label: "S2.1 Pro Free",
    description: "Free developer tier",
  },
  { id: "s2-pro", label: "S2 Pro", description: "Previous-generation S2" },
  { id: "s1", label: "S1", description: "Previous generation" },
  {
    id: "drama-3-preview",
    label: "Drama 3 Preview",
    description: "Preview availability may change",
  },
] as const;

/** Keep exact-match hits scope-honest: never promote a private voice to public. */
function exactMatchForQueryScope(
  voice: VoiceInfo,
  scope: VoiceCatalogQuery["scope"],
): VoiceInfo | null {
  if (scope === "public") {
    return voice.scope === "public" ? voice : null;
  }
  if (scope === "owned") {
    return { ...voice, scope: "owned" };
  }
  return voice;
}

export class FishAudioVoiceProvider implements VoiceProvider {
  /** Advertise Fish Audio's model catalog, speech synthesis, and transcription support. */
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: "fish-audio",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    };
  }

  /** Verify the user's Fish Audio API key against the model catalog endpoint. */
  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    try {
      const res = await fetch(`${API}/model?page_size=1&page_number=1`, {
        headers: fishAudioHeaders(apiKey),
        signal: voiceDeadline(context.signal, 20_000),
      });
      if (res.ok) return { ok: true };
      return {
        ok: false,
        message: voiceHttpError(
          res.status,
          "Fish Audio",
          "checking that key",
          await readVoiceJson(res),
        ),
      };
    } catch {
      return {
        ok: false,
        message: voiceUnreachable("Fish Audio"),
      };
    }
  }

  /** Return user-owned then bounded public Fish Audio voices as Rakazo choices. */
  async listVoices(apiKey: string, context: AdapterContext): Promise<VoiceInfo[]> {
    const signal = voiceDeadline(context.signal, LIST_VOICES_DEADLINE_MS);
    const listContext = { ...context, signal };
    const [publicModels, ownModels] = await Promise.all([
      fetchModels(apiKey, listContext, false),
      fetchModels(apiKey, listContext, true),
    ]);
    const seen = new Set<string>();
    return [...ownModels, ...publicModels]
      .map((model, index) => modelToVoice(model, index < ownModels.length ? "owned" : "public"))
      .filter((voice): voice is VoiceInfo => {
        if (!voice || seen.has(voice.id)) return false;
        seen.add(voice.id);
        return true;
      });
  }

  /** Search exactly one bounded Fish Audio catalog page using provider-side filters. */
  async searchVoices(
    apiKey: string,
    query: VoiceCatalogQuery,
    context: AdapterContext,
  ): Promise<VoiceCatalogPage> {
    const searchContext = {
      ...context,
      signal: voiceDeadline(context.signal, LIST_VOICES_DEADLINE_MS),
    };
    const requestedVoiceId = boundedQuery(query.voiceId);
    if (requestedVoiceId) {
      const voice = await this.getVoice(apiKey, requestedVoiceId, searchContext);
      const matched = voice ? exactMatchForQueryScope(voice, query.scope) : null;
      return {
        items: matched ? [matched] : [],
        windowLimited: false,
      };
    }

    const page = boundedPage(query.page);
    const pageSize = boundedPageSize(query.pageSize);
    const title = boundedQuery(query.query);
    const language = boundedQuery(query.language);
    const params = new URLSearchParams({
      page_size: String(pageSize),
      page_number: String(page),
      sort_by: "score",
      self: String(query.scope === "owned"),
    });
    if (title) params.set("title", title);
    if (language) params.set("language", language);

    const res = await fetch(`${API}/model?${params}`, {
      headers: fishAudioHeaders(apiKey),
      signal: searchContext.signal,
    });
    const body = await readVoiceJson(res, { requireValid: res.ok });
    if (!res.ok)
      throw new Error(voiceHttpError(res.status, "Fish Audio", "searching voices", body));

    const models = modelsFrom(body);
    const items = models
      .map((model) => modelToVoice(model, query.scope))
      .filter((voice): voice is VoiceInfo => voice !== null);
    if (items.length === 0 && looksLikeVoiceId(title)) {
      const voice = await this.getVoice(apiKey, title, searchContext);
      const matched = voice ? exactMatchForQueryScope(voice, query.scope) : null;
      if (matched) {
        return {
          items: [matched],
          windowLimited: false,
        };
      }
    }
    const hasMore = page < SEARCH_MAX_PAGE && modelPageHasMore(body, page, models.length, pageSize);
    const windowLimited = modelWindowIsLimited(body);
    return {
      items: dedupeVoices(items),
      nextPage: hasMore ? page + 1 : undefined,
      windowLimited,
    };
  }

  /** Resolve one Fish Audio model by ID so saved selections retain their name. */
  async getVoice(
    apiKey: string,
    voiceId: string,
    context: AdapterContext,
  ): Promise<VoiceInfo | null> {
    const id = voiceId.trim();
    if (!id) return null;
    const res = await fetch(`${API}/model/${encodeURIComponent(id)}`, {
      headers: fishAudioHeaders(apiKey),
      signal: voiceDeadline(context.signal, LIST_VOICES_DEADLINE_MS),
    });
    const body = await readVoiceJson(res, { requireValid: res.ok || res.status !== 404 });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(voiceHttpError(res.status, "Fish Audio", "loading voice", body));
    return modelToVoice(body && typeof body === "object" ? (body as Record<string, unknown>) : {});
  }

  /** Synthesize one Rakazo utterance as bounded MP3 audio. */
  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = voiceDeadline(request.signal ?? context.signal, 60_000);
    const res = await fetch(`${API}/v1/tts`, {
      method: "POST",
      headers: {
        ...fishAudioHeaders(request.apiKey),
        "content-type": "application/json",
        accept: "audio/mpeg",
        model: fishAudioTtsModel(request.modelId),
      },
      body: JSON.stringify({
        text: request.text,
        reference_id: request.voiceId,
        format: "mp3",
        mp3_bitrate: 64,
        latency: "balanced",
        normalize: true,
      }),
      signal,
    });
    await requireOk(res, "Fish Audio", "speaking");
    return { bytes: await readVoiceAudio(res, signal), mimeType: "audio/mpeg" };
  }

  /** Transcribe a browser recording through Fish Audio's multipart ASR endpoint. */
  async transcribe(
    request: VoiceTranscribeRequest,
    context: AdapterContext,
  ): Promise<{ text: string }> {
    const form = new FormData();
    form.set(
      "audio",
      new Blob([new Uint8Array(request.audio)], { type: request.mimeType || "audio/webm" }),
      speechUploadName(request.mimeType),
    );
    form.set("ignore_timestamps", "true");
    const res = await fetch(`${API}/v1/asr`, {
      method: "POST",
      headers: fishAudioHeaders(request.apiKey),
      body: form,
      signal: voiceDeadline(request.signal ?? context.signal, 60_000),
    });
    const body = await readVoiceJson(res, { requireValid: res.ok });
    if (!res.ok) throw new Error(voiceHttpError(res.status, "Fish Audio", "transcribing", body));
    return { text: String((body as { text?: unknown } | null)?.text ?? "").trim() };
  }
}

/** Accept only documented Fish Audio TTS model ids before writing the request header. */
function fishAudioTtsModel(modelId: string | undefined): string {
  const selected = modelId?.trim();
  if (!selected) return FISH_AUDIO_DEFAULT_TTS_MODEL;
  if (!FISH_AUDIO_TTS_MODELS.some((model) => model.id === selected)) {
    throw new Error(`Unknown Fish Audio TTS model "${selected}".`);
  }
  return selected;
}

/** Fetch public or user-owned Fish Audio voice models within a page budget. */
async function fetchModels(
  apiKey: string,
  context: AdapterContext,
  own: boolean,
): Promise<Array<Record<string, unknown>>> {
  const maxPages = own ? OWN_MODEL_PAGES : PUBLIC_MODEL_PAGES;
  const models: Array<Record<string, unknown>> = [];
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const params = new URLSearchParams({
      page_size: String(MODEL_PAGE_SIZE),
      page_number: String(pageNumber),
      sort_by: "score",
    });
    if (own) params.set("self", "true");
    const res = await fetch(`${API}/model?${params}`, {
      headers: fishAudioHeaders(apiKey),
      signal: context.signal,
    });
    const body = await readVoiceJson(res, { requireValid: res.ok });
    if (!res.ok) throw new Error(voiceHttpError(res.status, "Fish Audio", "listing voices", body));
    const items = modelsFrom(body);
    models.push(...items);
    if (items.length === 0 || !modelPageHasMore(body, pageNumber, items.length)) break;
  }
  return models;
}

/** Decide whether another Fish Audio model page should be requested. */
function modelPageHasMore(
  body: unknown,
  pageNumber: number,
  itemCount: number,
  pageSize = MODEL_PAGE_SIZE,
): boolean {
  if (!body || typeof body !== "object") return false;
  if (itemCount === 0) return false;
  const meta = body as {
    has_more?: unknown;
    total?: unknown;
    accessible_upper_bound?: unknown;
  };
  if (
    typeof meta.accessible_upper_bound === "number" &&
    Number.isFinite(meta.accessible_upper_bound) &&
    pageNumber * pageSize >= meta.accessible_upper_bound
  ) {
    return false;
  }
  if (typeof meta.has_more === "boolean") return meta.has_more;
  if (typeof meta.total === "number" && Number.isFinite(meta.total)) {
    return pageNumber * pageSize < meta.total;
  }
  return itemCount === pageSize;
}

/** Read Fish's accessible-window marker without making assumptions about totals. */
function modelWindowIsLimited(body: unknown): boolean {
  return Boolean(
    body &&
      typeof body === "object" &&
      (body as { window_limited?: unknown }).window_limited === true,
  );
}

/** Build the authorization header shared by Fish Audio requests. */
function fishAudioHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

/** Extract object-shaped model entries from a Fish Audio list response. */
function modelsFrom(body: unknown): Array<Record<string, unknown>> {
  if (!body || typeof body !== "object") return [];
  const items = (body as { items?: unknown }).items;
  return Array.isArray(items)
    ? items.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object"),
      )
    : [];
}

/** Convert a Fish Audio model into the provider-neutral voice shape. */
function modelToVoice(
  model: Record<string, unknown>,
  scope?: "public" | "owned",
): VoiceInfo | null {
  if (model.dmca_taken_down === true || model.state === "failed") return null;
  const id = asText(model._id) || asText(model.id);
  if (!id) return null;
  const label = asText(model.title) || asText(model.name) || "Voice";
  const description =
    [asText(model.description), languageLabel(model.languages)].filter(Boolean).join(" · ") ||
    undefined;
  const author = model.author;
  const authorRecord =
    author && typeof author === "object" ? (author as Record<string, unknown>) : null;
  const authorId = asText(authorRecord?._id) || asText(authorRecord?.id);
  const authorName = asText(authorRecord?.nickname) || asText(authorRecord?.name);
  const languages = languageValues(model.languages);
  const visibility = asText(model.visibility);
  return {
    id,
    label,
    ...(description ? { description } : {}),
    ...(scope || visibility === "public"
      ? { scope: scope ?? (visibility === "public" ? "public" : undefined) }
      : {}),
    ...(languages.length > 0 ? { languages } : {}),
    ...(authorId || authorName
      ? { author: { id: authorId || undefined, name: authorName || undefined } }
      : {}),
    ...(typeof model.licensed === "boolean" ? { licensed: model.licensed } : {}),
  };
}

/** Read a trimmed string field from an untyped provider response. */
function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Format the model language list for the voice picker description. */
function languageLabel(value: unknown): string {
  return languageValues(value).join(", ");
}

/** Normalize provider language metadata without exposing malformed values. */
function languageValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/** Keep page numbers inside the adapter's finite request budget. */
function boundedPage(value: number | undefined): number {
  return Number.isInteger(value) && value && value > 0 ? Math.min(value, SEARCH_MAX_PAGE) : 1;
}

/** Keep each upstream catalog request within the application result budget. */
function boundedPageSize(value: number | undefined): number {
  return Number.isInteger(value) && value && value > 0
    ? Math.min(value, SEARCH_MAX_PAGE_SIZE)
    : SEARCH_DEFAULT_PAGE_SIZE;
}

/** Trim and cap provider-side search text before putting it in a URL. */
function boundedQuery(value: string | undefined): string {
  return value?.trim().slice(0, SEARCH_MAX_QUERY_LENGTH) ?? "";
}

/** Recognize likely opaque Fish IDs without treating ordinary voice names as IDs. */
function looksLikeVoiceId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/.test(value);
}

/** Remove duplicate IDs while retaining provider ordering. */
function dedupeVoices(voices: VoiceInfo[]): VoiceInfo[] {
  const seen = new Set<string>();
  return voices.filter((voice) => {
    if (seen.has(voice.id)) return false;
    seen.add(voice.id);
    return true;
  });
}
