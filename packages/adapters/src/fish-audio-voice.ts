import type {
  AdapterContext,
  AdapterDescriptor,
  SpeechClip,
  VoiceCapabilities,
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
} from "./voice-http.js";

const API = "https://api.fish.audio";
const MODEL_PAGE_SIZE = 100;
/** Cap pages per query so a bad total/has_more cannot loop forever. */
const MODEL_PAGE_CAP = 20;
const TTS_MODEL = "s2.1-pro";

export class FishAudioVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: "fish-audio",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    };
  }

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
        message: "Couldn't reach Fish Audio to check that key — check your connection.",
      };
    }
  }

  async listVoices(apiKey: string, context: AdapterContext): Promise<VoiceInfo[]> {
    const [publicModels, ownModels] = await Promise.all([
      fetchModels(apiKey, context, false),
      fetchModels(apiKey, context, true),
    ]);
    const seen = new Set<string>();
    return [...publicModels, ...ownModels].map(modelToVoice).filter((voice): voice is VoiceInfo => {
      if (!voice || seen.has(voice.id)) return false;
      seen.add(voice.id);
      return true;
    });
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = voiceDeadline(request.signal ?? context.signal, 60_000);
    const res = await fetch(`${API}/v1/tts`, {
      method: "POST",
      headers: {
        ...fishAudioHeaders(request.apiKey),
        "content-type": "application/json",
        accept: "audio/mpeg",
        model: TTS_MODEL,
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

async function fetchModels(
  apiKey: string,
  context: AdapterContext,
  own: boolean,
): Promise<Array<Record<string, unknown>>> {
  const models: Array<Record<string, unknown>> = [];
  for (let pageNumber = 1; pageNumber <= MODEL_PAGE_CAP; pageNumber++) {
    const params = new URLSearchParams({
      page_size: String(MODEL_PAGE_SIZE),
      page_number: String(pageNumber),
      sort_by: "score",
    });
    if (own) params.set("self", "true");
    const res = await fetch(`${API}/model?${params}`, {
      headers: fishAudioHeaders(apiKey),
      signal: voiceDeadline(context.signal, 20_000),
    });
    const body = await readVoiceJson(res, { requireValid: res.ok });
    if (!res.ok) throw new Error(voiceHttpError(res.status, "Fish Audio", "listing voices", body));
    const items = modelsFrom(body);
    models.push(...items);
    if (!modelPageHasMore(body, pageNumber, items.length)) break;
  }
  return models;
}

function modelPageHasMore(body: unknown, pageNumber: number, itemCount: number): boolean {
  if (!body || typeof body !== "object") return false;
  const meta = body as { has_more?: unknown; total?: unknown };
  if (typeof meta.has_more === "boolean") return meta.has_more;
  if (typeof meta.total === "number" && Number.isFinite(meta.total)) {
    return pageNumber * MODEL_PAGE_SIZE < meta.total;
  }
  return itemCount === MODEL_PAGE_SIZE;
}

function fishAudioHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

function modelsFrom(body: unknown): Array<Record<string, unknown>> {
  if (!body || typeof body !== "object") return [];
  const items = (body as { items?: unknown }).items;
  return Array.isArray(items)
    ? items.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object"),
      )
    : [];
}

function modelToVoice(model: Record<string, unknown>): VoiceInfo | null {
  if (model.dmca_taken_down === true || model.state === "failed") return null;
  const id = asText(model._id) || asText(model.id);
  if (!id) return null;
  const label = asText(model.title) || asText(model.name) || "Voice";
  const description =
    [asText(model.description), languageLabel(model.languages)].filter(Boolean).join(" · ") ||
    undefined;
  return { id, label, description };
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function languageLabel(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .join(", ");
}
