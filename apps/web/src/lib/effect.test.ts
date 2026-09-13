import { describe, expect, it } from "vitest";
import { runUiTask, UiTaskError } from "./effect";

describe("runUiTask", () => {
  it("returns the successful value", async () => {
    await expect(runUiTask("test.success", async () => "ready")).resolves.toBe("ready");
  });

  it("keeps a stable operation name and cause", async () => {
    const cause = new Error("offline");
    const result = runUiTask("test.failure", async () => {
      throw cause;
    });

    await expect(result).rejects.toBeInstanceOf(UiTaskError);
    await expect(result).rejects.toMatchObject({ operation: "test.failure", cause });
  });
});
