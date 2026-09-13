import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Bot,
  VoiceCatalogEntry,
  VoiceCredential,
  VoiceInfo,
  VoiceStatus,
} from "@rakazo/contracts";
import { visibleVoiceLibraryItems } from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { XIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { rpc } from "../lib/rpc";

type VoiceBot = Pick<Bot, "id" | "name" | "voiceId"> & {
  /** Optional metadata returned by newer servers for an unavailable saved voice. */
  voiceLabel?: string | null;
};

type VoiceCredentialWithLabel = VoiceCredential & {
  /** Optional server-resolved display name for legacy selections. */
  voiceLabel?: string | null;
};

type VoiceLibraryItem = VoiceInfo & { alias?: string | null; favoriteId?: string };

export function VoiceSettingsOverlay({
  onClose,
  embedded = false,
  onBusyChange,
}: {
  onClose: () => void;
  /** Render panel body only for the shared Settings shell. */
  embedded?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const apiKeyId = useId();
  const voiceSelectId = useId();
  const modelSelectId = useId();
  const botVoiceIdPrefix = useId();
  const [catalog, setCatalog] = useState<VoiceCatalogEntry[]>([]);
  const [credentials, setCredentials] = useState<VoiceCredential[]>([]);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [voiceResults, setVoiceResults] = useState<VoiceLibraryItem[]>([]);
  const [favorites, setFavorites] = useState<VoiceLibraryItem[]>([]);
  const [voiceQuery, setVoiceQuery] = useState("");
  const [favoriteFilter, setFavoriteFilter] = useState(false);
  const [aliasVoiceId, setAliasVoiceId] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const [voiceLibraryPending, setVoiceLibraryPending] = useState(false);
  const [bots, setBots] = useState<VoiceBot[]>([]);
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [modelId, setModelId] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"connect" | "voice" | "test" | null>(null);
  const [botVoicePending, setBotVoicePending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const busy = pending !== null;

  useEffect(() => {
    return () => onBusyChange?.(false);
  }, [onBusyChange]);

  function markPending(next: "connect" | "voice" | "test" | null) {
    setPending(next);
    onBusyChange?.(next !== null);
  }

  async function refresh(nextProvider?: string) {
    const [nextCatalog, nextCredentials, nextStatus] = await Promise.all([
      rpc.voice.catalog(),
      rpc.voice.credentials(),
      rpc.voice.status(),
    ]);
    const nextBots = await rpc.bots.list().catch(() => []);
    const selected = nextProvider || provider || nextStatus.provider || nextCatalog[0]?.id || "";
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
    setStatus(nextStatus);
    setBots(nextBots);
    setProvider(selected);
    const cred = nextCredentials.find((entry) => entry.provider === selected);
    const catalogEntry = nextCatalog.find((entry) => entry.id === selected);
    const activeVoice = cred?.voiceId ?? "";
    setVoiceId(activeVoice);
    setModelId(cred?.modelId || catalogEntry?.defaultSynthesisModelId || "");
    if (cred) {
      const listed = await rpc.voice.voices({ provider: selected });
      setVoices(listed);
      setVoiceResults(listed);
      setFavorites(await loadFavoriteVoices(selected));
      if (!activeVoice && listed[0]) setVoiceId(listed[0].id);
    } else {
      setVoices([]);
      setVoiceResults([]);
      setFavorites([]);
    }
  }

  useEffect(() => {
    void refresh()
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : t`Could not load voice settings`),
      )
      .finally(() => setLoading(false));
  }, []);

  const selected = catalog.find((entry) => entry.id === provider) ?? catalog[0];
  const credential = credentials.find((entry) => entry.provider === provider);
  const voiceOptions = useMemo(
    () =>
      voices.length
        ? voices
        : voiceId
          ? [
              {
                id: voiceId,
                label:
                  (credential as VoiceCredentialWithLabel | undefined)?.voiceLabel ||
                  t`Unavailable voice`,
              },
            ]
          : [],
    [credential, t, voices, voiceId],
  );

  const visibleVoiceItems = useMemo(
    () => visibleVoiceLibraryItems(voiceResults, favorites, voiceQuery, favoriteFilter),
    [favoriteFilter, favorites, voiceQuery, voiceResults],
  );

  const assignableVoiceOptions = useMemo(() => {
    const combined = new Map<string, VoiceLibraryItem>();
    for (const voice of [...voiceOptions, ...voiceResults, ...favorites]) {
      combined.set(voice.id, { ...combined.get(voice.id), ...voice });
    }
    return [...combined.values()];
  }, [favorites, voiceOptions, voiceResults]);

  useEffect(() => {
    if (!credential || !provider) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setVoiceLibraryPending(true);
      void searchVoiceLibrary(provider, voiceQuery)
        .then((items) => {
          if (!cancelled) setVoiceResults(items);
        })
        .catch(() => {
          if (!cancelled) setVoiceResults([]);
        })
        .finally(() => {
          if (!cancelled) setVoiceLibraryPending(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [credential, provider, voiceQuery]);

  async function connectKey() {
    if (!selected || !apiKey.trim()) return;
    setError(null);
    setNotice(null);
    markPending("connect");
    try {
      await rpc.voice.connect({
        provider: selected.id,
        apiKey: apiKey.trim(),
        voiceId: voiceId || undefined,
        modelId: modelId || undefined,
      });
      setApiKey("");
      await refresh(selected.id);
      setNotice(t`Connected ${selected.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not connect this voice provider`);
    } finally {
      markPending(null);
    }
  }

  async function chooseVoice(nextVoiceId: string) {
    setVoiceId(nextVoiceId);
    if (!credential) return;
    markPending("voice");
    setError(null);
    try {
      const selectedVoice = assignableVoiceOptions.find((voice) => voice.id === nextVoiceId);
      await rpc.voice.setVoice({
        voiceId: nextVoiceId,
        modelId: modelId || undefined,
        provider: selected?.id,
        voiceLabel: selectedVoice?.alias || selectedVoice?.label || null,
      });
      await refresh(selected?.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save that voice`);
    } finally {
      markPending(null);
    }
  }

  /** Persist the provider model alongside the current voice selection. */
  async function chooseModel(nextModelId: string) {
    setModelId(nextModelId);
    if (!credential || !voiceId) return;
    markPending("voice");
    setError(null);
    try {
      await rpc.voice.setVoice({
        voiceId,
        modelId: nextModelId,
        provider: selected?.id,
      });
      await refresh(selected?.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save that model`);
    } finally {
      markPending(null);
    }
  }

  async function chooseBotVoice(botId: string, nextVoiceId: string) {
    if (botVoicePending) return;
    setBotVoicePending(botId);
    setError(null);
    try {
      const selectedVoice = nextVoiceId
        ? assignableVoiceOptions.find((voice) => voice.id === nextVoiceId)
        : undefined;
      const updated = await rpc.bots.update({
        botId,
        // An empty selection explicitly restores the space/account voice.
        voiceId: nextVoiceId || null,
        voiceProvider: nextVoiceId ? (selected?.id ?? null) : null,
        voiceModelId: nextVoiceId ? modelId || null : null,
        voiceLabel: nextVoiceId ? selectedVoice?.alias || selectedVoice?.label || null : null,
      });
      setBots((current) =>
        current.map((bot) => (bot.id === updated.id ? { ...bot, ...updated } : bot)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save that bot voice`);
    } finally {
      setBotVoicePending(null);
    }
  }

  async function toggleFavorite(voice: VoiceLibraryItem) {
    const favorite = favorites.find((item) => item.id === voice.id);
    try {
      if (favorite?.favoriteId) {
        await rpc.voice.favorites.delete({ id: favorite.favoriteId });
        setFavorites((current) => current.filter((item) => item.id !== voice.id));
      } else {
        const saved = await rpc.voice.favorites.create({
          provider,
          voiceId: voice.id,
          label: voice.alias ?? voice.label,
        });
        setFavorites((current) => [
          ...current.filter((item) => item.id !== voice.id),
          { ...voice, alias: saved.label, favoriteId: saved.id },
        ]);
      }
    } catch {
      setError(t`Could not update favorites`);
    }
  }

  async function saveVoiceAlias(voice: VoiceLibraryItem) {
    const alias = aliasDraft.trim() || null;
    const existing = favorites.find((item) => item.id === voice.id);
    const next = existing
      ? favorites.map((item) => (item.id === voice.id ? { ...item, alias } : item))
      : [...favorites, { ...voice, alias }];
    try {
      const saved = existing?.favoriteId
        ? await rpc.voice.favorites.update({ id: existing.favoriteId, label: alias })
        : await rpc.voice.favorites.create({ provider, voiceId: voice.id, label: alias });
      setFavorites(
        next.map((item) =>
          item.id === voice.id ? { ...item, alias: saved.label, favoriteId: saved.id } : item,
        ),
      );
      setAliasVoiceId(null);
    } catch {
      setError(t`Could not save that alias`);
    }
  }

  async function testVoice() {
    setError(null);
    setNotice(null);
    markPending("test");
    try {
      const { speaker } = await import("../lib/tts.js");
      await speaker.speak(t`Hi, this is how I'll sound when I read replies out loud.`);
      if (speaker.state.error) {
        setError(speaker.state.error);
        return;
      }
      setNotice(t`If you heard that, voice is ready.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not play a test clip`);
    } finally {
      markPending(null);
    }
  }

  const body = (
    <>
      {!embedded ? (
        <div className="flex items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <div>
            <DialogTitle className="text-2xl font-medium text-foreground">
              <Trans>Voice</Trans>
            </DialogTitle>
          </div>
          <DialogClose
            aria-label={t`Close voice settings`}
            disabled={busy}
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <XIcon />
          </DialogClose>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-6 py-6 sm:px-8 md:flex-row">
        <div className="flex min-h-0 shrink-0 flex-col md:w-[280px]">
          <div className="mb-3 text-[13.5px] text-muted-foreground">
            <Trans>Providers</Trans>
          </div>
          <div className="rk-scroll overflow-y-auto rounded-xl border border-border">
            {catalog.map((entry) => {
              const connected = credentials.some((cred) => cred.provider === entry.id);
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => {
                    setProvider(entry.id);
                    setApiKey("");
                    setVoiceQuery("");
                    setFavoriteFilter(false);
                    setError(null);
                    setNotice(null);
                    void refresh(entry.id);
                  }}
                  className={`flex w-full items-center gap-3 border-b border-border px-3.5 py-3 text-start transition-colors last:border-0 ${
                    entry.id === provider ? "bg-muted" : "hover:bg-accent"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-foreground">{entry.name}</span>
                    <span className="mt-0.5 block text-[12px] text-muted-foreground/80">
                      {entry.transcribe ? (
                        <Trans>Speak + transcribe</Trans>
                      ) : (
                        <Trans>Speak only</Trans>
                      )}
                    </span>
                  </span>
                  {connected ? (
                    <span className="text-[12px] text-success">
                      <Trans>Connected</Trans>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <div className="rk-scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Loading voice providers…</Trans>
            </p>
          ) : null}
          {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
          {notice ? <p className="mb-4 text-sm text-success">{notice}</p> : null}
          {selected ? (
            <>
              <Field className="mt-5">
                <FieldLabel htmlFor={apiKeyId}>
                  <Trans>API key</Trans>
                </FieldLabel>
                <Input
                  id={apiKeyId}
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={credential ? t`Paste a replacement key` : t`Paste your API key`}
                />
              </Field>
              {selected.synthesisModels?.length ? (
                <Field className="mt-4">
                  <FieldLabel htmlFor={modelSelectId}>
                    <Trans>Model</Trans>
                  </FieldLabel>
                  <NativeSelect
                    id={modelSelectId}
                    className="w-full"
                    value={modelId}
                    onChange={(event) => void chooseModel(event.target.value)}
                  >
                    {selected.synthesisModels.map((model) => (
                      <NativeSelectOption key={model.id} value={model.id}>
                        {model.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              ) : null}
              <Button
                type="button"
                className="mt-3"
                disabled={busy || apiKey.trim().length < 8}
                onClick={() => void connectKey()}
              >
                {pending === "connect" ? (
                  <Trans>Connecting…</Trans>
                ) : credential ? (
                  <Trans>Replace key</Trans>
                ) : (
                  <Trans>Connect</Trans>
                )}
              </Button>

              {credential ? (
                <>
                  <Field className="mt-6">
                    <FieldLabel htmlFor={voiceSelectId}>
                      <Trans>Voice</Trans>
                    </FieldLabel>
                    <NativeSelect
                      id={voiceSelectId}
                      className="w-full"
                      value={voiceId}
                      onChange={(event) => void chooseVoice(event.target.value)}
                    >
                      {voiceOptions.map((voice) => (
                        <NativeSelectOption key={voice.id} value={voice.id}>
                          {voice.label}
                          {voice.description ? ` · ${voice.description}` : ""}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Button
                    type="button"
                    variant="secondary"
                    className="mt-4 rounded-full"
                    disabled={busy || !status?.ready}
                    onClick={() => void testVoice()}
                  >
                    {pending === "test" ? <Trans>Playing…</Trans> : <Trans>Hear a sample</Trans>}
                  </Button>
                  <section data-testid="voice-library" className="mt-6">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-[14px] text-muted-foreground">
                        <Trans>Voice library</Trans>
                      </h3>
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant={favoriteFilter ? "ghost" : "secondary"}
                          onClick={() => setFavoriteFilter(false)}
                        >
                          <Trans>All</Trans>
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={favoriteFilter ? "secondary" : "ghost"}
                          onClick={() => setFavoriteFilter(true)}
                        >
                          <Trans>Favorites</Trans>
                        </Button>
                      </div>
                    </div>
                    <Input
                      className="mt-2"
                      value={voiceQuery}
                      onChange={(event) => setVoiceQuery(event.target.value)}
                      placeholder={t`Search voices`}
                      aria-label={t`Search voices`}
                    />
                    <div className="mt-2 divide-y divide-border rounded-xl border border-border">
                      {voiceLibraryPending ? (
                        <p className="px-3.5 py-3 text-[13px] text-muted-foreground">
                          <Trans>Searching voices…</Trans>
                        </p>
                      ) : null}
                      {!voiceLibraryPending && visibleVoiceItems.length === 0 ? (
                        <p className="px-3.5 py-3 text-[13px] text-muted-foreground">
                          <Trans>No matching voices</Trans>
                        </p>
                      ) : null}
                      {visibleVoiceItems.map((voice) => {
                        const isFavorite = favorites.some((item) => item.id === voice.id);
                        return (
                          <div key={voice.id} className="flex items-center gap-2 px-3.5 py-3">
                            <button
                              type="button"
                              className="min-w-0 flex-1 text-start"
                              onClick={() => void chooseVoice(voice.id)}
                            >
                              <span className="block truncate text-[14px] text-foreground">
                                {voice.alias || voice.label}
                              </span>
                              <span className="block truncate text-[12px] text-muted-foreground">
                                {voice.description || voice.label}
                              </span>
                            </button>
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              aria-label={
                                isFavorite ? t`Remove from favorites` : t`Add to favorites`
                              }
                              onClick={() => void toggleFavorite(voice)}
                            >
                              <span
                                aria-hidden="true"
                                className={isFavorite ? "text-foreground" : "text-muted-foreground"}
                              >
                                {isFavorite ? "★" : "☆"}
                              </span>
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setAliasVoiceId(voice.id);
                                setAliasDraft(voice.alias ?? "");
                              }}
                            >
                              <Trans>Alias</Trans>
                            </Button>
                            {aliasVoiceId === voice.id ? (
                              <div className="flex gap-1">
                                <Input
                                  className="w-28"
                                  value={aliasDraft}
                                  onChange={(event) => setAliasDraft(event.target.value)}
                                  aria-label={t`Voice alias`}
                                />
                                <Button
                                  type="button"
                                  size="sm"
                                  onClick={() => void saveVoiceAlias(voice)}
                                >
                                  <Trans>Save</Trans>
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                  <section data-testid="fish-bot-voices" className="mt-6">
                    <h3 className="text-[14px] text-muted-foreground">
                      <Trans>Bot voices</Trans>
                    </h3>
                    <div className="mt-2 divide-y divide-border rounded-xl border border-border">
                      {bots.map((bot) => {
                        const selectedVoice = bot.voiceId ?? "";
                        const selectedVoiceInfo = voiceOptions.find(
                          (voice) => voice.id === selectedVoice,
                        );
                        const botVoiceOptions =
                          selectedVoice && !selectedVoiceInfo
                            ? [
                                {
                                  id: selectedVoice,
                                  label: bot.voiceLabel || t`Unavailable voice`,
                                },
                                ...assignableVoiceOptions,
                              ]
                            : assignableVoiceOptions;
                        return (
                          <label
                            key={bot.id}
                            htmlFor={`${botVoiceIdPrefix}-bot-${bot.id}`}
                            className="flex items-center gap-3 px-3.5 py-3 text-[14px]"
                          >
                            <span className="min-w-0 flex-1 truncate text-foreground">
                              {bot.name}
                            </span>
                            <NativeSelect
                              id={`${botVoiceIdPrefix}-bot-${bot.id}`}
                              className="w-[min(240px,55%)]"
                              value={selectedVoice}
                              disabled={botVoicePending !== null || !botVoiceOptions.length}
                              onChange={(event) => void chooseBotVoice(bot.id, event.target.value)}
                            >
                              <NativeSelectOption value="">
                                <Trans>Account default</Trans>
                              </NativeSelectOption>
                              {botVoiceOptions.map((voice) => (
                                <NativeSelectOption key={voice.id} value={voice.id}>
                                  {voice.alias || voice.label}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                          </label>
                        );
                      })}
                    </div>
                  </section>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </>
  );

  if (embedded) {
    return (
      <div data-testid="voice-settings" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {body}
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (busy) {
          details.cancel();
          return;
        }
        onClose();
      }}
    >
      <DialogContent
        data-testid="voice-settings"
        aria-describedby={undefined}
        showCloseButton={false}
        className="flex h-[min(680px,calc(100%-2rem))] w-[920px] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:h-[min(680px,calc(100%-5rem))] sm:max-w-[calc(100%-5rem)]"
      >
        {body}
      </DialogContent>
    </Dialog>
  );
}

async function searchVoiceLibrary(provider: string, query: string): Promise<VoiceLibraryItem[]> {
  const result = await rpc.voice.search({
    provider,
    query: query.trim() || undefined,
    page: 1,
    pageSize: 50,
  });
  return result.items;
}

async function loadFavoriteVoices(provider: string): Promise<VoiceLibraryItem[]> {
  const saved = await rpc.voice.favorites.list({ provider });
  return saved.map((item) => ({
    id: item.voiceId,
    label: item.label || item.voiceId,
    alias: item.label,
    favoriteId: item.id,
  }));
}
