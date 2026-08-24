import { describe, expect, it, vi } from "vitest";
import { applyMobileUiDirection, resolveMobileUiLocale } from "./ui-direction";

vi.mock("react-native", () => ({
  I18nManager: {
    allowRTL: vi.fn(),
    forceRTL: vi.fn(),
    isRTL: false,
  },
}));

describe("mobile ui direction", () => {
  it("resolves a locale tag from Intl", () => {
    expect(resolveMobileUiLocale()).toMatch(/^[a-z]{2}(-[A-Z]{2})?$/i);
  });

  it("forces rtl layout for Hebrew", async () => {
    const { I18nManager } = await import("react-native");
    expect(applyMobileUiDirection("he-IL")).toBe(true);
    expect(I18nManager.allowRTL).toHaveBeenCalledWith(true);
    expect(I18nManager.forceRTL).toHaveBeenCalledWith(true);
  });
});
