import { describe, expect, it } from "vitest";
import { type VoiceLibraryItem, visibleVoiceLibraryItems } from "./voice-library.js";

const results: VoiceLibraryItem[] = [
  { id: "alpha", label: "Alpha Voice", description: "bright" },
  { id: "beta", label: "Beta Voice" },
];

const favorites: VoiceLibraryItem[] = [
  { id: "fav-only", label: "Saved Favorite", alias: "Nick", favoriteId: "f1" },
  { id: "alpha", label: "Alpha Voice", alias: "A", favoriteId: "f2" },
];

describe("visibleVoiceLibraryItems", () => {
  it("keeps unrelated favorites out of search results", () => {
    const items = visibleVoiceLibraryItems(results, favorites, "beta", false);
    expect(items.map((v) => v.id)).toEqual(["beta"]);
  });

  it("matches favorites by alias when searching", () => {
    const items = visibleVoiceLibraryItems(results, favorites, "nick", false);
    expect(items.map((v) => v.id)).toEqual(["fav-only"]);
  });

  it("shows all favorites when the query is empty", () => {
    const items = visibleVoiceLibraryItems(results, favorites, "  ", true);
    expect(items.map((v) => v.id).sort()).toEqual(["alpha", "fav-only"]);
  });

  it("applies Favorites-tab filter after the query", () => {
    const items = visibleVoiceLibraryItems(results, favorites, "alpha", true);
    expect(items.map((v) => v.id)).toEqual(["alpha"]);
    expect(items[0]?.alias).toBe("A");
  });
});
