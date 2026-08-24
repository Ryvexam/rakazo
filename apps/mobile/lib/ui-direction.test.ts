import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMobileUiDirection, resolveMobileUiLocale } from "./ui-direction";

vi.mock("react-native", () => ({
  I18nManager: {
    allowRTL: vi.fn(),
    forceRTL: vi.fn(),
    isRTL: false,
  },
}));

describe("mobile ui direction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves a locale tag from Intl", () => {
    const resolvedOptions = vi.fn().mockReturnValue({ locale: "he-IL" });
    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: vi.fn().mockImplementation(() => ({ resolvedOptions })),
    });

    expect(resolveMobileUiLocale()).toBe("he-IL");
  });

  it("forces rtl layout for Hebrew", async () => {
    const { I18nManager } = await import("react-native");
    expect(applyMobileUiDirection("he-IL")).toBe(true);
    expect(I18nManager.allowRTL).toHaveBeenCalledWith(true);
    expect(I18nManager.forceRTL).toHaveBeenCalledWith(true);
  });
});
