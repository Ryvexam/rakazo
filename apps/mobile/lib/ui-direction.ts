import { textDirectionForLocale } from "@rakazo/core";
import { I18nManager } from "react-native";

export function resolveMobileUiLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale || "en";
}

export function applyMobileUiDirection(locale = resolveMobileUiLocale()) {
  const rtl = textDirectionForLocale(locale) === "rtl";
  // Always allow RTL so a later locale switch can take effect after relaunch.
  I18nManager.allowRTL(true);
  // forceRTL persists and applies on the next cold start (RN contract).
  if (I18nManager.isRTL !== rtl) {
    I18nManager.forceRTL(rtl);
  }
  return rtl;
}
