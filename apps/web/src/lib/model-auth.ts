import type { ModelCatalogEntry } from "@ryvoko/contracts";
import { waitForModelOAuthCompletion } from "@ryvoko/core";
import { rpc } from "./rpc";

export type { ModelCatalogEntry, ModelCredential, ModelOAuthBegin } from "@ryvoko/contracts";
export { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@ryvoko/core";

/** English fallback auth hint for a catalog entry (localize at the UI call site). */
export function providerHint(entry: ModelCatalogEntry) {
  if (entry.authHint) return entry.authHint;
  if (entry.signIn !== undefined) return "Sign in";
  if (entry.auth === "oauth") return "Skip or deploy key";
  return "API key";
}

export async function waitForModelOAuth(loginId: string, signal?: AbortSignal) {
  return waitForModelOAuthCompletion(() => rpc.models.completeOAuth({ loginId }, { signal }), {
    signal,
  });
}
