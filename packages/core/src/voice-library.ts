/** Voice row shown in the library list (provider result and/or saved favorite). */
export type VoiceLibraryItem = {
  id: string;
  label: string;
  description?: string;
  alias?: string | null;
  favoriteId?: string;
};

/**
 * Merge provider search hits with saved favorites, then apply the search query
 * and optional Favorites-tab filter. Favorites must be filtered by the query
 * after the merge so unrelated saved voices do not reappear in search results.
 */
export function visibleVoiceLibraryItems(
  voiceResults: VoiceLibraryItem[],
  favorites: VoiceLibraryItem[],
  voiceQuery: string,
  favoriteFilter: boolean,
): VoiceLibraryItem[] {
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
    items = items.filter((voice) =>
      [voice.id, voice.label, voice.description, voice.alias]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  }
  return favoriteFilter
    ? items.filter((voice) => favorites.some((item) => item.id === voice.id))
    : items;
}
