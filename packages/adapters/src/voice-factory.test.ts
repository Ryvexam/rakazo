import { afterEach, describe, expect, it, vi } from "vitest";
import { CartesiaVoiceProvider } from "./cartesia-voice.js";
import { ElevenLabsVoiceProvider } from "./elevenlabs-voice.js";
import { FishAudioVoiceProvider } from "./fish-audio-voice.js";
import { OpenAIVoiceProvider } from "./openai-voice.js";
import {
  SCRIPTED_MPEG,
  SCRIPTED_TRANSCRIPT,
  SCRIPTED_VOICE_ID,
  ScriptedVoiceProvider,
} from "./scripted-voice.js";
import {
  createVoiceProvider,
  isVoiceProviderId,
  listVoiceCatalog,
  VOICE_CATALOG,
} from "./voice-factory.js";
import { MAX_SYNTHESIZED_AUDIO_BYTES } from "./voice-http.js";

const ctx = {
  operationId: "voice",
  traceId: "voice",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const previousRuntime = process.env.AGENT_RUNTIME;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (previousRuntime === undefined) delete process.env.AGENT_RUNTIME;
  else process.env.AGENT_RUNTIME = previousRuntime;
});

describe("createVoiceProvider", () => {
  it("exposes the hosted catalog behind one factory", () => {
    process.env.AGENT_RUNTIME = "pi";
    expect(VOICE_CATALOG.map((entry) => entry.id)).toEqual([
      "elevenlabs",
      "openai",
      "cartesia",
      "fish-audio",
    ]);
    expect(listVoiceCatalog().map((entry) => entry.id)).toEqual([
      "elevenlabs",
      "openai",
      "cartesia",
      "fish-audio",
    ]);
    expect(createVoiceProvider("elevenlabs").describe().id).toBe("elevenlabs");
    expect(createVoiceProvider("openai").describe().capabilities.transcribe).toBe(true);
    expect(createVoiceProvider("cartesia").describe().capabilities.transcribe).toBe(false);
    expect(createVoiceProvider("fish-audio").describe().capabilities.transcribe).toBe(true);
    expect(VOICE_CATALOG.find((entry) => entry.id === "fish-audio")).toMatchObject({
      defaultSynthesisModelId: "s2.1-pro",
      synthesisModels: expect.arrayContaining([
        expect.objectContaining({ id: "s2.1-pro" }),
        expect.objectContaining({ id: "s2.1-pro-free" }),
      ]),
    });
    expect(isVoiceProviderId("elevenlabs")).toBe(true);
    expect(isVoiceProviderId("scripted")).toBe(false);
    expect(isVoiceProviderId("piper")).toBe(false);
    expect(() => createVoiceProvider("piper")).toThrow(/unknown voice provider/i);
    expect(() => createVoiceProvider("scripted")).toThrow(/unknown voice provider/i);
  });

  it("adds the scripted fixture only when the agent runtime is scripted", () => {
    process.env.AGENT_RUNTIME = "scripted";
    expect(listVoiceCatalog().some((entry) => entry.id === "scripted")).toBe(true);
    expect(isVoiceProviderId("scripted")).toBe(true);
    expect(createVoiceProvider("scripted").describe().id).toBe("scripted");
  });
});

describe("ElevenLabsVoiceProvider", () => {
  it("verifies against /voices so restricted speech keys still pass", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ voices: [{ voice_id: "abc", name: "Rachel" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ElevenLabsVoiceProvider();
    await expect(provider.verify("sk_test_key", ctx)).resolves.toEqual({ ok: true });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/voices");
  });

  it("synthesizes one utterance as mp3 bytes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ElevenLabsVoiceProvider();
    const clip = await provider.synthesize(
      { text: "Hello there.", voiceId: "abc", apiKey: "sk_test_key" },
      ctx,
    );
    expect(clip.mimeType).toBe("audio/mpeg");
    expect([...clip.bytes]).toEqual([1, 2, 3]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/text-to-speech/abc");
  });

  it("transcribes through Scribe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "hello there" }))),
    );
    const provider = new ElevenLabsVoiceProvider();
    await expect(
      provider.transcribe!(
        { audio: new Uint8Array([1]), mimeType: "audio/webm", apiKey: "sk" },
        ctx,
      ),
    ).resolves.toEqual({ text: "hello there" });
  });
});

describe("OpenAIVoiceProvider", () => {
  it("returns a static voice catalog without a network round trip", async () => {
    const provider = new OpenAIVoiceProvider();
    const voices = await provider.listVoices("sk-test", ctx);
    expect(voices.some((voice) => voice.id === "alloy")).toBe(true);
  });

  it("posts speech to /audio/speech", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([9]).buffer,
    });
    vi.stubGlobal("fetch", fetchMock);
    const clip = await new OpenAIVoiceProvider().synthesize(
      { text: "Hi", voiceId: "alloy", apiKey: "sk-test" },
      ctx,
    );
    expect(clip.mimeType).toBe("audio/mpeg");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/audio/speech");
  });

  it("names Firefox ogg recordings from the mime type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "hello" })));
    vi.stubGlobal("fetch", fetchMock);
    await new OpenAIVoiceProvider().transcribe!(
      { audio: new Uint8Array([1]), mimeType: "audio/ogg;codecs=opus", apiKey: "sk-test" },
      ctx,
    );
    const form = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("speech.ogg");
  });
});

describe("CartesiaVoiceProvider", () => {
  it("maps the voices list from either array or { data } payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ id: "sonic", name: "Katie" }] })),
        ),
    );
    const provider = new CartesiaVoiceProvider();
    const voices = await provider.listVoices("sk-test", ctx);
    expect(voices).toEqual([{ id: "sonic", label: "Katie", description: undefined }]);
  });

  it("posts bytes to /tts/bytes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([4, 5]).buffer,
    });
    vi.stubGlobal("fetch", fetchMock);
    const clip = await new CartesiaVoiceProvider().synthesize(
      { text: "Hi", voiceId: "sonic", apiKey: "sk-test" },
      ctx,
    );
    expect([...clip.bytes]).toEqual([4, 5]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/tts/bytes");
  });
});

describe("FishAudioVoiceProvider", () => {
  it("lists own then public voice models without duplicates", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ _id: "public-id", title: "Public Voice", languages: ["en", "fr"] }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              { _id: "private-id", title: "Private Voice", description: "My clone" },
              { _id: "public-id", title: "Duplicate" },
              { _id: "failed-id", title: "Failed", state: "failed" },
            ],
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const voices = await new FishAudioVoiceProvider().listVoices("sk-test", ctx);

    expect(voices).toEqual([
      {
        id: "private-id",
        label: "Private Voice",
        description: "My clone",
        scope: "owned",
      },
      {
        id: "public-id",
        label: "Duplicate",
        scope: "owned",
      },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("page_size=100");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("self=true");
  });

  it("pages through Fish Audio model listings until has_more is false", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page_number") ?? "1");
      const own = url.searchParams.get("self") === "true";
      const prefix = own ? "own" : "pub";
      return new Response(
        JSON.stringify({
          total: 2,
          has_more: page < 2,
          items: [{ _id: `${prefix}-${page}`, title: `${own ? "Own" : "Public"} ${page}` }],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const voices = await new FishAudioVoiceProvider().listVoices("sk-test", ctx);

    expect(voices.map((voice) => voice.id)).toEqual(["own-1", "own-2", "pub-1", "pub-2"]);
    expect(voices.some((voice) => voice.label === "Public 2")).toBe(true);
    expect(voices.some((voice) => voice.label === "Own 2")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(
      fetchMock.mock.calls
        .map((call) => String(call[0]))
        .filter((url) => url.includes("page_number=2")),
    ).toHaveLength(2);
  });

  it("keeps paging when total implies more pages without has_more", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page_number") ?? "1");
      const own = url.searchParams.get("self") === "true";
      if (own) {
        return new Response(
          JSON.stringify({ total: 1, items: [{ _id: "own-only", title: "Own" }] }),
        );
      }
      return new Response(
        JSON.stringify({
          total: 101,
          items:
            page === 1
              ? Array.from({ length: 100 }, (_, index) => ({
                  _id: `pub-${index + 1}`,
                  title: `Public ${index + 1}`,
                }))
              : [{ _id: "pub-101", title: "Public 101" }],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const voices = await new FishAudioVoiceProvider().listVoices("sk-test", ctx);

    expect(voices.some((voice) => voice.id === "pub-101")).toBe(true);
    expect(voices.some((voice) => voice.label === "Public 101")).toBe(true);
    expect(
      fetchMock.mock.calls.some(
        (call) =>
          String(call[0]).includes("page_number=2") && !String(call[0]).includes("self=true"),
      ),
    ).toBe(true);
  });

  it("stops catalog crawls at page caps when has_more stays true", async () => {
    const publicPages = 5;
    const ownPages = 20;
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page_number") ?? "1");
      const own = url.searchParams.get("self") === "true";
      const prefix = own ? "own" : "pub";
      const start = (page - 1) * 100;
      return new Response(
        JSON.stringify({
          total: 1_000_000,
          has_more: true,
          items: Array.from({ length: 100 }, (_, index) => ({
            _id: `${prefix}-${start + index + 1}`,
            title: `${own ? "Own" : "Public"} ${start + index + 1}`,
          })),
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const voices = await new FishAudioVoiceProvider().listVoices("sk-test", ctx);

    expect(voices).toHaveLength(ownPages * 100 + publicPages * 100);
    expect(voices[0]?.id).toBe("own-1");
    expect(voices.at(ownPages * 100)?.id).toBe("pub-1");
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes("self=true")),
    ).toHaveLength(ownPages);
    expect(
      fetchMock.mock.calls.filter((call) => !String(call[0]).includes("self=true")),
    ).toHaveLength(publicPages);
  });

  it("searches one bounded page with Fish-side title and language filters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          total: 101,
          has_more: true,
          window_limited: false,
          items: [
            {
              _id: "voice-fr",
              title: "French Narrator",
              description: "A warm voice",
              languages: ["fr"],
              author: { _id: "author-1", nickname: "Voice Studio" },
              licensed: true,
            },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new FishAudioVoiceProvider().searchVoices!(
      "sk-test",
      { scope: "public", query: " french ", language: "fr", page: 2, pageSize: 100 },
      ctx,
    );

    expect(result).toEqual({
      items: [
        {
          id: "voice-fr",
          label: "French Narrator",
          description: "A warm voice · fr",
          scope: "public",
          languages: ["fr"],
          author: { id: "author-1", name: "Voice Studio" },
          licensed: true,
        },
      ],
      nextPage: 3,
      windowLimited: false,
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("self")).toBe("false");
    expect(url.searchParams.get("title")).toBe("french");
    expect(url.searchParams.get("language")).toBe("fr");
    expect(url.searchParams.get("page_number")).toBe("2");
    expect(url.searchParams.get("page_size")).toBe("50");
  });

  it("stops at Fish's accessible window while reporting that results are limited", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          total: 1_000_000,
          has_more: true,
          window_limited: true,
          accessible_upper_bound: 60,
          items: Array.from({ length: 30 }, (_, index) => ({
            _id: `voice-${index + 1}`,
            title: `Voice ${index + 1}`,
          })),
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new FishAudioVoiceProvider().searchVoices!(
      "sk-test",
      { scope: "owned", page: 2, pageSize: 30 },
      ctx,
    );

    expect(result.nextPage).toBeUndefined();
    expect(result.windowLimited).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("self=true");
  });

  it("keeps the next page while a window still has accessible results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            total: 1_000_000,
            has_more: true,
            window_limited: true,
            accessible_upper_bound: 60,
            items: [{ _id: "voice-1", title: "Voice 1" }],
          }),
        ),
      ),
    );

    const result = await new FishAudioVoiceProvider().searchVoices!(
      "sk-test",
      { scope: "public", page: 1, pageSize: 30 },
      ctx,
    );

    expect(result.nextPage).toBe(2);
    expect(result.windowLimited).toBe(true);
  });

  it("stops pagination at SEARCH_MAX_PAGE even when Fish reports has_more", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            total: 1_000_000,
            has_more: true,
            items: [{ _id: "voice-1", title: "Voice 1", visibility: "public" }],
          }),
        ),
      ),
    );

    const result = await new FishAudioVoiceProvider().searchVoices!(
      "sk-test",
      { scope: "public", page: 10_000, pageSize: 30 },
      ctx,
    );

    expect(result.nextPage).toBeUndefined();
  });

  it("rejects a private exact match for a public search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes("/model/private-voice")) {
          return new Response(
            JSON.stringify({
              _id: "private-voice",
              title: "Private Voice",
              visibility: "private",
            }),
          );
        }
        return new Response(JSON.stringify({ total: 0, has_more: false, items: [] }));
      }),
    );

    const byId = await new FishAudioVoiceProvider().searchVoices!(
      "sk-test",
      { scope: "public", voiceId: "private-voice" },
      ctx,
    );
    expect(byId.items).toEqual([]);

    const owned = await new FishAudioVoiceProvider().searchVoices!(
      "sk-test",
      { scope: "owned", voiceId: "private-voice" },
      ctx,
    );
    expect(owned.items).toEqual([expect.objectContaining({ id: "private-voice", scope: "owned" })]);
  });

  it("ends pagination on an empty page even when Fish reports has_more", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ total: 1_000_000, has_more: true, items: [] })),
        ),
    );

    const result = await new FishAudioVoiceProvider().searchVoices!(
      "sk-test",
      { scope: "public", page: 1, pageSize: 30 },
      ctx,
    );

    expect(result.items).toEqual([]);
    expect(result.nextPage).toBeUndefined();
  });

  it("looks up an exact voice ID for favorites outside the current page", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          _id: "saved-voice-123",
          title: "Saved Support Voice",
          languages: ["en"],
          visibility: "private",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new FishAudioVoiceProvider().searchVoices!(
      "sk-test",
      { scope: "owned", voiceId: "saved-voice-123" },
      ctx,
    );

    expect(result.items).toEqual([
      {
        id: "saved-voice-123",
        label: "Saved Support Voice",
        description: "en",
        scope: "owned",
        languages: ["en"],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.fish.audio/model/saved-voice-123",
    );
  });

  it("falls back to an exact ID lookup when a name search returns no result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], has_more: false })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ _id: "voice-123456", title: "Favorite", visibility: "public" }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new FishAudioVoiceProvider().searchVoices!(
      "sk-test",
      { scope: "public", query: "voice-123456" },
      ctx,
    );

    expect(result.items[0]).toMatchObject({
      id: "voice-123456",
      label: "Favorite",
      scope: "public",
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://api.fish.audio/model/voice-123456");
  });

  it("resolves a selected voice by ID with display metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          _id: "selected-id",
          title: "My French Clone",
          description: "Used by the support bot",
          visibility: "private",
          languages: ["fr", "en"],
          author: { _id: "me", nickname: "Maxime" },
          licensed: false,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new FishAudioVoiceProvider().getVoice!("sk-test", "selected-id", ctx),
    ).resolves.toEqual({
      id: "selected-id",
      label: "My French Clone",
      description: "Used by the support bot · fr, en",
      languages: ["fr", "en"],
      author: { id: "me", name: "Maxime" },
      licensed: false,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.fish.audio/model/selected-id");
  });

  it("returns null for an inaccessible selected voice", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new FishAudioVoiceProvider().getVoice!("sk-test", "missing-id", ctx),
    ).resolves.toBe(null);
  });

  it("synthesizes with the Fish Audio TTS contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([7, 8]).buffer,
    });
    vi.stubGlobal("fetch", fetchMock);

    const clip = await new FishAudioVoiceProvider().synthesize(
      { text: "Hi", voiceId: "voice-id", apiKey: "sk-test" },
      ctx,
    );

    expect(clip.mimeType).toBe("audio/mpeg");
    expect([...clip.bytes]).toEqual([7, 8]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.fish.audio/v1/tts");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).model).toBe("s2.1-pro");
    expect(JSON.parse(String(init.body))).toMatchObject({
      text: "Hi",
      reference_id: "voice-id",
      format: "mp3",
    });
  });

  it("uses the selected Fish Audio TTS model", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([7, 8]).buffer,
    });
    vi.stubGlobal("fetch", fetchMock);

    await new FishAudioVoiceProvider().synthesize(
      {
        text: "Hi",
        voiceId: "voice-id",
        modelId: "s2.1-pro-free",
        apiKey: "sk-test",
      },
      ctx,
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).model).toBe("s2.1-pro-free");
  });

  it("rejects unknown Fish Audio TTS model ids before making a request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([7, 8]).buffer,
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new FishAudioVoiceProvider().synthesize(
        { text: "Hi", voiceId: "voice-id", modelId: "unknown", apiKey: "sk-test" },
        ctx,
      ),
    ).rejects.toThrow('Unknown Fish Audio TTS model "unknown".');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("transcribes through Fish Audio ASR", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "hello" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new FishAudioVoiceProvider().transcribe!(
        { audio: new Uint8Array([1]), mimeType: "audio/ogg;codecs=opus", apiKey: "sk-test" },
        ctx,
      ),
    ).resolves.toEqual({ text: "hello" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.fish.audio/v1/asr");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const form = init.body as FormData;
    expect((form.get("audio") as File).name).toBe("speech.ogg");
    expect(form.get("ignore_timestamps")).toBe("true");
  });
});

describe("hosted voice response limits", () => {
  it.each([
    ["ElevenLabs", () => new ElevenLabsVoiceProvider(), "voice"],
    ["OpenAI", () => new OpenAIVoiceProvider(), "alloy"],
    ["Cartesia", () => new CartesiaVoiceProvider(), "sonic"],
    ["Fish Audio", () => new FishAudioVoiceProvider(), "voice"],
  ])(
    "rejects an oversized %s speech response before buffering it",
    async (_name, create, voiceId) => {
      const cancel = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          headers: new Headers({
            "content-length": String(MAX_SYNTHESIZED_AUDIO_BYTES + 1),
          }),
          body: { cancel },
        }),
      );

      await expect(
        create().synthesize({ text: "Hi", voiceId, apiKey: "sk-test" }, ctx),
      ).rejects.toThrow("Voice response is too large.");
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
});

describe("ScriptedVoiceProvider", () => {
  it("verifies, lists, speaks, and transcribes without a network", async () => {
    const provider = new ScriptedVoiceProvider();
    await expect(provider.verify("short", ctx)).resolves.toEqual({
      ok: false,
      message: "That key is too short.",
    });
    await expect(provider.verify("fake-scripted-voice-key", ctx)).resolves.toEqual({ ok: true });
    expect(await provider.listVoices("fake-scripted-voice-key", ctx)).toEqual([
      { id: SCRIPTED_VOICE_ID, label: "Scripted", description: "Test voice" },
    ]);
    const clip = await provider.synthesize(
      { text: "Hello", voiceId: SCRIPTED_VOICE_ID, apiKey: "fake-scripted-voice-key" },
      ctx,
    );
    expect(clip.mimeType).toBe("audio/mpeg");
    expect([...clip.bytes]).toEqual([...SCRIPTED_MPEG]);
    await expect(
      provider.transcribe(
        {
          audio: new Uint8Array([1]),
          mimeType: "audio/webm",
          apiKey: "fake-scripted-voice-key",
        },
        ctx,
      ),
    ).resolves.toEqual({ text: SCRIPTED_TRANSCRIPT });
  });
});
