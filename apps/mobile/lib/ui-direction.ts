import { textDirectionForLocale } from "@rakazo/core";
import { I18nManager } from "react-native";

export function resolveMobileUiLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale || "en";
}

export function applyMobileUiDirection(locale = resolveMobileUiLocale()) {
  const rtl = textDirectionForLocale(locale) === "rtl";
  I18nManager.allowRTL(rtl);
  I18nManager.forceRTL(rtl);
  return rtl;
}
