const STORAGE_KEY = "rakazo:ui-locale";

export function readStoredUiLocale(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function resolveUiLocale(): string {
  return readStoredUiLocale() ?? navigator.language ?? "en";
}
