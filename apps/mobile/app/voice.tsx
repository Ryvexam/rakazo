import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { type MobileBot, rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { speakText } from "../lib/voice";

type VoiceCatalogEntry = {
  id: string;
  name: string;
  description: string;
  transcribe: boolean;
  synthesisModels?: Array<{ id: string; label: string; description?: string }>;
  defaultSynthesisModelId?: string;
};
type VoiceCredential = {
  id: string;
  provider: string;
  voiceId: string;
  modelId: string;
};
type VoiceStatus = {
  configured: boolean;
  ready: boolean;
  provider: string | null;
  voiceId: string;
  modelId: string;
};
type VoiceInfo = { id: string; label: string; description?: string };
type VoiceLibraryItem = VoiceInfo & { alias?: string | null; favoriteId?: string };
type VoiceBot = MobileBot & {
  voiceId?: string | null;
  voiceLabel?: string | null;
};

export default function VoiceSettings() {
  const styles = useThemedStyles(createVoiceStyles);
  const { t } = useI18n();
  const colorScheme = useResolvedAppearance();
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
  const [bots, setBots] = useState<VoiceBot[]>([]);
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [modelId, setModelId] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [botVoicePending, setBotVoicePending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (nextProvider?: string) => {
    const [nextCatalog, nextCredentials, nextStatus] = await Promise.all([
      rpc<VoiceCatalogEntry[]>("voice/catalog"),
      rpc<VoiceCredential[]>("voice/credentials"),
      rpc<VoiceStatus>("voice/status"),
    ]);
    const nextBots = await rpc<VoiceBot[]>("bots/list").catch(() => []);
    const selected = nextProvider || nextStatus.provider || nextCatalog[0]?.id || "";
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
    setStatus(nextStatus);
    setBots(nextBots);
    setProvider(selected);
    const cred = nextCredentials.find((entry) => entry.provider === selected);
    const catalogEntry = nextCatalog.find((entry) => entry.id === selected);
    setVoiceId(cred?.voiceId ?? "");
    setModelId(cred?.modelId || catalogEntry?.defaultSynthesisModelId || "");
    if (cred) {
      const listed = await rpc<VoiceInfo[]>("voice/voices", { provider: selected });
      setVoices(listed);
      setVoiceResults(listed);
      setFavorites(await loadFavoriteVoices(selected));
    } else {
      setVoices([]);
      setVoiceResults([]);
      setFavorites([]);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load()
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : t("Could not load voice settings")),
        )
        .finally(() => setLoading(false));
    }, [load]),
  );

  const selected = catalog.find((entry) => entry.id === provider);
  const credential = credentials.find((entry) => entry.provider === provider);

  useEffect(() => {
    if (!credential || !provider) return;
    const timer = setTimeout(() => {
      void searchVoiceLibrary(provider, voiceQuery)
        .then(setVoiceResults)
        .catch(() => setVoiceResults([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [credential, provider, voiceQuery]);

  async function connect() {
    if (!selected || apiKey.trim().length < 8) return;
    setPending(true);
    setError(null);
    try {
      await rpc("voice/connect", {
        provider: selected.id,
        apiKey: apiKey.trim(),
        voiceId: voiceId || undefined,
        modelId: modelId || undefined,
      });
      setApiKey("");
      await load(selected.id);
      setNotice(t("Connected {name}.", { name: selected.name }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not connect"));
    } finally {
      setPending(false);
    }
  }

  async function chooseVoice(nextVoiceId: string) {
    setVoiceId(nextVoiceId);
    setPending(true);
    try {
      await rpc("voice/setVoice", {
        voiceId: nextVoiceId,
        modelId: modelId || undefined,
        provider: selected?.id,
      });
      await load(selected?.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not save that voice"));
    } finally {
      setPending(false);
    }
  }

  /** Persist the provider model alongside the current voice selection. */
  async function chooseModel(nextModelId: string) {
    setModelId(nextModelId);
    if (!credential || !voiceId) return;
    setPending(true);
    setError(null);
    try {
      await rpc("voice/setVoice", {
        voiceId,
        modelId: nextModelId,
        provider: selected?.id,
      });
      await load(selected?.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not save that model"));
    } finally {
      setPending(false);
    }
  }

  function openBotVoicePicker(bot: VoiceBot) {
    if (botVoicePending) return;
    const selectedVoice = bot.voiceId ?? "";
    const assignable = [
      ...new Map(
        [...voices, ...voiceResults, ...favorites].map((voice) => [voice.id, voice]),
      ).values(),
    ].map(
      (voice): VoiceLibraryItem => ({
        ...voice,
        alias: "alias" in voice && typeof voice.alias === "string" ? voice.alias : null,
      }),
    );
    const selectedInfo = assignable.find((voice) => voice.id === selectedVoice);
    const options =
      selectedVoice && !selectedInfo
        ? [
            {
              id: selectedVoice,
              label: bot.voiceLabel || t("Unavailable voice"),
              alias: null,
            },
            ...assignable,
          ]
        : assignable;
    presentMessageActionSheet({
      title: bot.name,
      actions: [
        {
          text: t("Account default"),
          onPress: () => void chooseBotVoice(bot.id, "", null),
        },
        ...options.map((voice) => ({
          text: voice.alias || voice.label,
          onPress: () => void chooseBotVoice(bot.id, voice.id, voice.alias || voice.label),
        })),
      ],
      cancel: t("Cancel"),
      more: t("More"),
      colorScheme,
    });
  }

  async function chooseBotVoice(
    botId: string,
    nextVoiceId: string,
    nextVoiceLabel: string | null,
  ) {
    if (botVoicePending) return;
    setBotVoicePending(botId);
    setError(null);
    try {
      const updated = await rpc<VoiceBot>("bots/update", {
        botId,
        // Empty selection explicitly restores the account/space default.
        voiceId: nextVoiceId || null,
        voiceProvider: nextVoiceId ? (selected?.id ?? null) : null,
        voiceModelId: nextVoiceId ? modelId || null : null,
        voiceLabel: nextVoiceId ? nextVoiceLabel : null,
      });
      setBots((current) => current.map((bot) => (bot.id === updated.id ? updated : bot)));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not save that bot voice"));
    } finally {
      setBotVoicePending(null);
    }
  }

  async function toggleFavorite(voice: VoiceLibraryItem) {
    const favorite = favorites.find((item) => item.id === voice.id);
    try {
      if (favorite?.favoriteId) {
        await rpc("voice/favorites/delete", { id: favorite.favoriteId });
        setFavorites((current) => current.filter((item) => item.id !== voice.id));
      } else {
        const saved = await rpc<{ id: string; label: string | null }>("voice/favorites/create", {
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
      setError(t("Could not update favorites"));
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
        ? await rpc<{ id: string; label: string | null }>("voice/favorites/update", {
            id: existing.favoriteId,
            label: alias,
          })
        : await rpc<{ id: string; label: string | null }>("voice/favorites/create", {
            provider,
            voiceId: voice.id,
            label: alias,
          });
      setFavorites(
        next.map((item) =>
          item.id === voice.id ? { ...item, alias: saved.label, favoriteId: saved.id } : item,
        ),
      );
      setAliasVoiceId(null);
    } catch {
      setError(t("Could not save that alias"));
    }
  }

  async function testVoice() {
    setPending(true);
    setError(null);
    try {
      const ready = await speakText(t("Hi, this is how I'll sound when I read replies out loud."));
      if (!ready) {
        throw new Error(t("Connect a voice provider first."));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not play a sample"));
    } finally {
      setPending(false);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        {loading ? <ActivityIndicator color={native.secondaryLabel} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        {catalog.map((entry) => {
          const connected = credentials.some((cred) => cred.provider === entry.id);
          return (
            <Pressable
              key={entry.id}
              onPress={() => {
                setProvider(entry.id);
                setVoiceQuery("");
                setFavoriteFilter(false);
                void load(entry.id);
              }}
              style={[styles.card, provider === entry.id && styles.cardActive]}
            >
              <Text style={styles.cardTitle}>{entry.name}</Text>
              <Text style={styles.cardMeta}>
                {connected
                  ? t("Connected")
                  : entry.transcribe
                    ? t("Speak + transcribe")
                    : t("Speak only")}
              </Text>
            </Pressable>
          );
        })}
        {selected ? (
          <>
            <TextInput
              accessibilityLabel={t("API key")}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect={false}
              importantForAutofill="no"
              value={apiKey}
              onChangeText={setApiKey}
              placeholder={credential ? t("Paste a replacement key") : t("Paste your API key")}
              placeholderTextColor={native.tertiaryLabel}
              secureTextEntry
              style={styles.input}
              textContentType="none"
            />
            {selected.synthesisModels?.length ? (
              <View style={styles.options}>
                <Text style={styles.optionHeading}>{t("Model")}</Text>
                {selected.synthesisModels.map((model) => (
                  <Pressable
                    key={model.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: modelId === model.id }}
                    onPress={() => void chooseModel(model.id)}
                    style={styles.optionRow}
                  >
                    <View style={styles.optionCopy}>
                      <Text style={styles.voiceLabel}>{model.label}</Text>
                      {model.description ? (
                        <Text style={styles.optionDescription}>{model.description}</Text>
                      ) : null}
                    </View>
                    {modelId === model.id ? <Text style={styles.check}>✓</Text> : null}
                  </Pressable>
                ))}
              </View>
            ) : null}
            <Pressable
              disabled={pending || apiKey.trim().length < 8}
              onPress={() => void connect()}
              style={[styles.button, (pending || apiKey.trim().length < 8) && styles.disabled]}
            >
              <Text style={styles.buttonLabel}>{credential ? t("Replace key") : t("Connect")}</Text>
            </Pressable>
            {voices.length ? (
              <View style={styles.voices}>
                {voices.map((voice) => (
                  <Pressable
                    key={voice.id}
                    onPress={() => void chooseVoice(voice.id)}
                    style={styles.voiceRow}
                  >
                    <Text style={styles.voiceLabel}>{voice.label}</Text>
                    {voiceId === voice.id ? <Text style={styles.check}>✓</Text> : null}
                  </Pressable>
                ))}
              </View>
            ) : null}
            {status?.ready ? (
              <Pressable
                disabled={pending}
                onPress={() => void testVoice()}
                style={styles.secondary}
              >
                <Text style={styles.secondaryLabel}>{t("Hear a sample")}</Text>
              </Pressable>
            ) : null}
            <View style={styles.library}>
              <View style={styles.libraryHeader}>
                <Text style={styles.optionHeading}>{t("Voice library")}</Text>
                <View style={styles.filterButtons}>
                  <Pressable onPress={() => setFavoriteFilter(false)}>
                    <Text style={favoriteFilter ? styles.filterLabel : styles.filterActive}>
                      {t("All")}
                    </Text>
                  </Pressable>
                  <Pressable onPress={() => setFavoriteFilter(true)}>
                    <Text style={favoriteFilter ? styles.filterActive : styles.filterLabel}>
                      {t("Favorites")}
                    </Text>
                  </Pressable>
                </View>
              </View>
              <TextInput
                value={voiceQuery}
                onChangeText={setVoiceQuery}
                placeholder={t("Search voices by name or ID")}
                placeholderTextColor={native.tertiaryLabel}
                accessibilityLabel={t("Search voices by name or ID")}
                style={styles.searchInput}
              />
              {voiceResults
                .filter(
                  (voice) => !favoriteFilter || favorites.some((item) => item.id === voice.id),
                )
                .map((voice) => {
                  const favorite = favorites.some((item) => item.id === voice.id);
                  const alias = favorites.find((item) => item.id === voice.id)?.alias;
                  return (
                    <View key={voice.id} style={styles.libraryRow}>
                      <Pressable
                        style={styles.libraryCopy}
                        onPress={() => void chooseVoice(voice.id)}
                      >
                        <Text style={styles.voiceLabel}>{alias || voice.label}</Text>
                        {voice.description ? (
                          <Text style={styles.optionDescription}>
                            {voice.description} · {voice.id}
                          </Text>
                        ) : (
                          <Text style={styles.optionDescription}>{voice.id}</Text>
                        )}
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={
                          favorite ? t("Remove from favorites") : t("Add to favorites")
                        }
                        onPress={() => void toggleFavorite(voice)}
                      >
                        <Text style={favorite ? styles.favoriteActive : styles.filterLabel}>
                          {favorite ? "★" : "☆"}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          setAliasVoiceId(voice.id);
                          setAliasDraft(alias || "");
                        }}
                      >
                        <Text style={styles.filterLabel}>{t("Alias")}</Text>
                      </Pressable>
                      {aliasVoiceId === voice.id ? (
                        <View style={styles.aliasEditor}>
                          <TextInput
                            value={aliasDraft}
                            onChangeText={setAliasDraft}
                            placeholder={t("Alias")}
                            placeholderTextColor={native.tertiaryLabel}
                            style={styles.aliasInput}
                          />
                          <Pressable onPress={() => void saveVoiceAlias(voice)}>
                            <Text style={styles.filterActive}>{t("Save")}</Text>
                          </Pressable>
                        </View>
                      ) : null}
                    </View>
                  );
                })}
            </View>
            <View style={styles.botVoices}>
              <Text style={styles.optionHeading}>{t("Bot voices")}</Text>
              {bots.map((bot) => {
                const selectedVoice = bot.voiceId ?? "";
                const selectedInfo = voices.find((voice) => voice.id === selectedVoice);
                const label =
                  selectedInfo?.label ??
                  (selectedVoice ? bot.voiceLabel || t("Unavailable voice") : t("Account default"));
                return (
                  <Pressable
                    key={bot.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${bot.name}: ${label}`}
                    disabled={botVoicePending !== null || !voices.length}
                    onPress={() => openBotVoicePicker(bot)}
                    style={[styles.botVoiceRow, !voices.length && styles.disabled]}
                  >
                    <Text style={styles.voiceLabel}>{bot.name}</Text>
                    <Text style={styles.botVoiceValue}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createVoiceStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 10 },
    error: { color: tokens.destructive, marginBottom: 8 },
    notice: { color: tokens.success, marginBottom: 8 },
    card: {
      borderRadius: 14,
      borderWidth: 1,
      borderColor: tokens.border,
      padding: 14,
      backgroundColor: tokens.card,
    },
    cardActive: { borderColor: tokens.ring, backgroundColor: tokens.muted },
    cardTitle: { color: native.label, fontSize: 16 },
    cardMeta: { color: native.tertiaryLabel, marginTop: 4, fontSize: 12 },
    input: {
      marginTop: 8,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: tokens.border,
      color: native.label,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    button: {
      marginTop: 8,
      backgroundColor: tokens.primary,
      borderRadius: 12,
      paddingVertical: 12,
      alignItems: "center",
    },
    disabled: { opacity: 0.4 },
    buttonLabel: { color: tokens.primaryForeground, fontWeight: "600" },
    options: { marginTop: 12, borderRadius: 12, borderWidth: 1, borderColor: tokens.border },
    optionHeading: {
      color: native.secondaryLabel,
      fontSize: 12,
      paddingHorizontal: 14,
      paddingTop: 10,
      paddingBottom: 4,
    },
    optionRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    optionCopy: { flex: 1, paddingRight: 12 },
    optionDescription: { color: native.tertiaryLabel, fontSize: 12, marginTop: 2 },
    voices: { marginTop: 12, borderRadius: 12, borderWidth: 1, borderColor: tokens.border },
    botVoices: { marginTop: 16, borderRadius: 12, borderWidth: 1, borderColor: tokens.border },
    library: { marginTop: 16, borderRadius: 12, borderWidth: 1, borderColor: tokens.border },
    libraryHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingRight: 14,
    },
    filterButtons: { flexDirection: "row", gap: 12 },
    filterLabel: { color: native.secondaryLabel, fontSize: 13 },
    filterActive: { color: native.label, fontSize: 13, fontWeight: "600" },
    favoriteActive: { color: tokens.success, fontSize: 17 },
    searchInput: {
      marginHorizontal: 12,
      marginBottom: 8,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: tokens.border,
      color: native.label,
      paddingHorizontal: 12,
      paddingVertical: 9,
    },
    libraryRow: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 11,
      borderTopWidth: 1,
      borderTopColor: tokens.border,
    },
    libraryCopy: { flex: 1, minWidth: 120 },
    aliasEditor: { flexDirection: "row", alignItems: "center", gap: 8, width: "100%" },
    aliasInput: {
      flex: 1,
      borderRadius: 9,
      borderWidth: 1,
      borderColor: tokens.border,
      color: native.label,
      paddingHorizontal: 10,
      paddingVertical: 7,
    },
    voiceRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    voiceLabel: { color: native.label },
    botVoiceRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    botVoiceValue: { color: native.secondaryLabel, flexShrink: 1, textAlign: "right" },
    check: { color: tokens.success },
    secondary: { marginTop: 16, alignItems: "center" },
    secondaryLabel: { color: native.secondaryLabel, fontSize: 15 },
  });
}

async function searchVoiceLibrary(provider: string, query: string): Promise<VoiceLibraryItem[]> {
  try {
    const result = await rpc<{ items: VoiceLibraryItem[] }>("voice/search", {
      provider,
      query: query.trim() || undefined,
      page: 1,
      pageSize: 50,
    });
    return result.items;
  } catch {
    const response = await rpc<VoiceInfo[]>("voice/voices", { provider });
    const normalized = query.trim().toLocaleLowerCase();
    return response.filter(
      (voice) =>
        !normalized ||
        [voice.id, voice.label, voice.description]
          .filter(Boolean)
          .some((value) => value?.toLocaleLowerCase().includes(normalized)),
    );
  }
}

async function loadFavoriteVoices(provider: string): Promise<VoiceLibraryItem[]> {
  try {
    const saved = await rpc<Array<{ id: string; voiceId: string; label: string | null }>>(
      "voice/favorites/list",
      { provider },
    );
    return saved.map((item) => ({
      id: item.voiceId,
      label: item.label || item.voiceId,
      alias: item.label,
      favoriteId: item.id,
    }));
  } catch {
    return [];
  }
}
