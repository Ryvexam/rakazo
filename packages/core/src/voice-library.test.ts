import { describe, expect, it } from "vitest";
import { type VoiceLibraryItem, visibleVoiceLibraryItems } from "./voice-library.js";

const favorites: VoiceLibraryItem[] = [
  { id: "fav-only", label: "Saved Favorite", alias: "Nick", favoriteId: "f1" },
  { id: "alpha", label: "Alpha Voice", alias: "A", favoriteId: "f2" },
  {
    id: "author-fav",
    label: "Quiet Night",
    author: { name: "Morgan" },
    favoriteId: "f3",
  },
];

describe("visibleVoiceLibraryItems", () => {
  it("keeps unrelated favorites out of search results", () => {
    const serverHits: VoiceLibraryItem[] = [{ id: "beta", label: "Beta Voice" }];
    const items = visibleVoiceLibraryItems(serverHits, favorites, "beta", false);
    expect(items.map((v) => v.id)).toEqual(["beta"]);
  });

  it("keeps provider hits that matched only via author", () => {
    // Server already matched on author; label does not contain the query.
    const serverHits: VoiceLibraryItem[] = [
      { id: "author-hit", label: "River Song", author: { name: "Casey" } },
    ];
    const items = visibleVoiceLibraryItems(serverHits, favorites, "casey", false);
    expect(items.map((v) => v.id)).toEqual(["author-hit"]);
  });

  it("matches favorite-only rows by alias when searching", () => {
    const items = visibleVoiceLibraryItems([], favorites, "nick", false);
    expect(items.map((v) => v.id)).toEqual(["fav-only"]);
  });

  it("matches favorite-only rows by author name", () => {
    const items = visibleVoiceLibraryItems([], favorites, "morgan", false);
    expect(items.map((v) => v.id)).toEqual(["author-fav"]);
  });

  it("shows all favorites when the query is empty", () => {
    const serverHits: VoiceLibraryItem[] = [
      { id: "alpha", label: "Alpha Voice", description: "bright" },
      { id: "beta", label: "Beta Voice" },
    ];
    const items = visibleVoiceLibraryItems(serverHits, favorites, "  ", true);
    expect(items.map((v) => v.id).sort()).toEqual(["alpha", "author-fav", "fav-only"]);
  });

  it("applies Favorites-tab filter after the query", () => {
    const serverHits: VoiceLibraryItem[] = [
      { id: "alpha", label: "Alpha Voice", description: "bright" },
    ];
    const items = visibleVoiceLibraryItems(serverHits, favorites, "alpha", true);
    expect(items.map((v) => v.id)).toEqual(["alpha"]);
    expect(items[0]?.alias).toBe("A");
  });
});
