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
    vi.clearAllMocks();
  });

  it("resolves a locale tag from Intl", () => {
    const resolvedOptions = vi.fn().mockReturnValue({ locale: "he-IL" });
    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: vi.fn().mockImplementation(() => ({ resolvedOptions })),
    });

    expect(resolveMobileUiLocale()).toBe("he-IL");
  });

  it("forces rtl layout for Hebrew when the runtime is still ltr", async () => {
    const { I18nManager } = await import("react-native");
    (I18nManager as { isRTL: boolean }).isRTL = false;
    expect(applyMobileUiDirection("he-IL")).toBe(true);
    expect(I18nManager.allowRTL).toHaveBeenCalledWith(true);
    expect(I18nManager.forceRTL).toHaveBeenCalledWith(true);
  });

  it("skips forceRTL when layout already matches the locale", async () => {
    const { I18nManager } = await import("react-native");
    (I18nManager as { isRTL: boolean }).isRTL = true;
    expect(applyMobileUiDirection("he-IL")).toBe(true);
    expect(I18nManager.allowRTL).toHaveBeenCalledWith(true);
    expect(I18nManager.forceRTL).not.toHaveBeenCalled();
  });
});
