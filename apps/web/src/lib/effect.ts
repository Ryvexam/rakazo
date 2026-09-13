import { Effect } from "effect";

/** An operation name makes async UI failures observable without leaking provider details. */
export class UiTaskError extends Error {
  readonly operation: string;
  override readonly cause: unknown;

  constructor(operation: string, cause: unknown) {
    super(`UI task failed: ${operation}`, { cause });
    this.name = "UiTaskError";
    this.operation = operation;
    this.cause = cause;
  }
}

/**
 * Keeps Effect at the UI boundary: React owns lifecycle/state, while Effect gives
 * async work one typed failure boundary and a stable operation name.
 */
export function runUiTask<A>(operation: string, task: () => Promise<A>): Promise<A> {
  const workflow = Effect.tryPromise({
    try: task,
    catch: (cause) => new UiTaskError(operation, cause),
  });
  return Effect.runPromise(Effect.either(workflow)).then((result) => {
    if (result._tag === "Left") throw result.left;
    return result.right;
  });
}
