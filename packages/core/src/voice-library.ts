/** Voice row shown in the library list (provider result and/or saved favorite). */
export type VoiceLibraryItem = {
  id: string;
  label: string;
  description?: string;
  alias?: string | null;
  favoriteId?: string;
  author?: { id?: string; name?: string };
};

/** Match fields used by pageListedVoices, plus favorite alias. */
function matchesVoiceQuery(voice: VoiceLibraryItem, query: string): boolean {
  return [voice.id, voice.label, voice.description, voice.alias, voice.author?.name]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query));
}

/**
 * Merge provider search hits with saved favorites, then apply the search query
 * and optional Favorites-tab filter.
 *
 * Provider hits are kept as returned (Fish and listVoices fallbacks can match
 * on author and other server-side fields). Only favorite-only rows are filtered
 * by the local query so unrelated saved voices do not reappear in search.
 */
export function visibleVoiceLibraryItems(
  voiceResults: VoiceLibraryItem[],
  favorites: VoiceLibraryItem[],
  voiceQuery: string,
  favoriteFilter: boolean,
): VoiceLibraryItem[] {
  const resultIds = new Set(voiceResults.map((voice) => voice.id));
  const combined = new Map<string, VoiceLibraryItem>();
  for (const voice of voiceResults) combined.set(voice.id, voice);
  for (const voice of favorites) {
    const existing = combined.get(voice.id);
    combined.set(voice.id, {
      ...voice,
      ...existing,
      alias: voice.alias ?? existing?.alias,
    });
  }
  const query = voiceQuery.trim().toLowerCase();
  let items = [...combined.values()];
  if (query) {
    items = items.filter((voice) => resultIds.has(voice.id) || matchesVoiceQuery(voice, query));
  }
  return favoriteFilter
    ? items.filter((voice) => favorites.some((item) => item.id === voice.id))
    : items;
}
