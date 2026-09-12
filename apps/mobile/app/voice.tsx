import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
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
      setVoices(await rpc<VoiceInfo[]>("voice/voices", { provider: selected }));
    } else {
      setVoices([]);
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
    const selectedInfo = voices.find((voice) => voice.id === selectedVoice);
    const options =
      selectedVoice && !selectedInfo
        ? [{ id: selectedVoice, label: bot.voiceLabel || t("Unavailable voice") }, ...voices]
        : voices;
    presentMessageActionSheet({
      title: bot.name,
      actions: [
        {
          text: t("Account default"),
          onPress: () => void chooseBotVoice(bot.id, ""),
        },
        ...options.map((voice) => ({
          text: voice.label,
          onPress: () => void chooseBotVoice(bot.id, voice.id),
        })),
      ],
      cancel: t("Cancel"),
      more: t("More"),
      colorScheme,
    });
  }

  async function chooseBotVoice(botId: string, nextVoiceId: string) {
    if (botVoicePending) return;
    setBotVoicePending(botId);
    setError(null);
    try {
      const updated = await rpc<VoiceBot>("bots/update", {
        botId,
        // Empty selection explicitly restores the account/space default.
        voiceId: nextVoiceId || null,
        voiceProvider: nextVoiceId ? (selected?.id ?? null) : null,
        voiceModelId: null,
      });
      setBots((current) => current.map((bot) => (bot.id === updated.id ? updated : bot)));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not save that bot voice"));
    } finally {
      setBotVoicePending(null);
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
