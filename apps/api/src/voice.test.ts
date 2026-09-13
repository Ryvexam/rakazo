import type { Actor } from "@ryvoko/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_SPEAK_REQUEST_BYTES,
  MAX_TRANSCRIBE_REQUEST_BYTES,
  mountVoiceHttpRoutes,
  pageListedVoices,
  resolvePersistedVoiceLabel,
  toVoiceStatus,
  type VoiceDeps,
} from "./voice.js";

describe("toVoiceStatus", () => {
  it("treats a saved key without a voice as configured but not ready", () => {
    expect(toVoiceStatus({ provider: "elevenlabs", voiceId: "", modelId: "" })).toEqual({
      configured: true,
      ready: false,
      transcribe: true,
      provider: "elevenlabs",
      voiceId: "",
      modelId: "",
      voiceLabel: null,
    });
  });

  it("is ready once a voice is chosen", () => {
    expect(toVoiceStatus({ provider: "cartesia", voiceId: "katie", modelId: "" }).ready).toBe(true);
    expect(toVoiceStatus({ provider: "cartesia", voiceId: "katie", modelId: "" }).transcribe).toBe(
      false,
    );
  });

  it("is off when nothing is connected", () => {
    expect(toVoiceStatus(null)).toEqual({
      configured: false,
      ready: false,
      transcribe: false,
      provider: null,
      voiceId: "",
      modelId: "",
      voiceLabel: null,
    });
  });

  it("uses the Fish Audio default for preferences created before model selection", () => {
    expect(toVoiceStatus({ provider: "fish-audio", voiceId: "voice", modelId: "" }).modelId).toBe(
      "s2.1-pro",
    );
  });

  it("exposes a saved voice label without exposing any credential material", () => {
    expect(
      toVoiceStatus({
        provider: "fish-audio",
        voiceId: "voice-id",
        modelId: "s2.1-pro",
        voiceLabel: "French Narrator",
      }),
    ).toMatchObject({ voiceId: "voice-id", voiceLabel: "French Narrator" });
  });
});

describe("voice HTTP routes", () => {
  it("rejects unauthenticated speak and transcribe", async () => {
    const app = new Hono();
    mountVoiceHttpRoutes(app, {} as VoiceDeps, async () => null);
    const speak = await app.request("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    const transcribe = await app.request("/api/voice/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audioBase64: "AAAA", mimeType: "audio/webm" }),
    });
    expect(speak.status).toBe(401);
    expect(transcribe.status).toBe(401);
  });

  it.each([
    ["/api/voice/speak", MAX_SPEAK_REQUEST_BYTES],
    ["/api/voice/transcribe", MAX_TRANSCRIBE_REQUEST_BYTES],
  ])(
    "rejects a declared oversized body on %s without waiting for cancellation",
    async (path, max) => {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const request = new Request(`http://localhost${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(max + 1),
        },
        body: new ReadableStream({ cancel }),
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const app = new Hono();
      mountVoiceHttpRoutes(
        app,
        {} as VoiceDeps,
        async () => ({ userId: "user", spaceId: "space" }) as Actor,
      );

      const response = await app.request(request);

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "Request body is too large." });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("stops reading a streamed oversized speak body", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const request = new Request("http://localhost/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_SPEAK_REQUEST_BYTES + 1));
        },
        cancel,
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const app = new Hono();
    mountVoiceHttpRoutes(
      app,
      {} as VoiceDeps,
      async () => ({ userId: "user", spaceId: "space" }) as Actor,
    );

    const response = await app.request(request);

    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("pageListedVoices", () => {
  const voices = [
    { id: "alpha", label: "Alpha", description: "bright", languages: ["en"] },
    { id: "bravo", label: "Bravo", description: "warm", languages: ["fr"] },
    { id: "charlie", label: "Charlie", description: "deep", languages: ["en"] },
  ];

  it("filters by query and pages the remaining voices", () => {
    expect(pageListedVoices(voices, { query: "a", page: 1, pageSize: 2 })).toEqual({
      items: [
        { id: "alpha", label: "Alpha", description: "bright", languages: ["en"] },
        { id: "bravo", label: "Bravo", description: "warm", languages: ["fr"] },
      ],
      nextPage: 2,
    });
    expect(pageListedVoices(voices, { query: "a", page: 2, pageSize: 2 })).toEqual({
      items: [{ id: "charlie", label: "Charlie", description: "deep", languages: ["en"] }],
    });
  });

  it("filters by language without inventing a next page", () => {
    expect(pageListedVoices(voices, { page: 1, pageSize: 10, language: "fr" })).toEqual({
      items: [{ id: "bravo", label: "Bravo", description: "warm", languages: ["fr"] }],
    });
  });
});

describe("resolvePersistedVoiceLabel", () => {
  it("drops the previous label when the explicit voice id changes", () => {
    expect(
      resolvePersistedVoiceLabel({
        explicitVoiceId: "voice-b",
        lookedUpLabel: null,
        previousVoiceId: "voice-a",
        previousVoiceLabel: "Old voice",
      }),
    ).toBeNull();
  });

  it("keeps the previous label when reconnecting the same voice id", () => {
    expect(
      resolvePersistedVoiceLabel({
        explicitVoiceId: "voice-a",
        lookedUpLabel: null,
        previousVoiceId: "voice-a",
        previousVoiceLabel: "Saved voice",
      }),
    ).toBe("Saved voice");
  });
});
