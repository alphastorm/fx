import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIFECYCLE_TASK_PROMPT,
  comparisonOrder,
  loadLifecycleComparisonConfig,
  runBunTestFile,
  runLifecycleComparison,
  writeHeldOutLifecycleVerifier,
  writeLifecycleFixture,
} from "./composed-lifecycle-eval";

describe("composed lifecycle fixture", () => {
  test("frozen flaw passes visible tests and fails the held-out transition", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fx-lifecycle-flawed-"));
    try {
      writeLifecycleFixture(dir, "flawed");
      expect(existsSync(join(dir, "held-out-lifecycle.test.ts"))).toBe(false);

      const visible = await runBunTestFile(dir, "pool.test.ts");
      expect(visible.code).toBe(0);

      writeHeldOutLifecycleVerifier(dir);
      const heldOut = await runBunTestFile(dir, "held-out-lifecycle.test.ts");
      expect(heldOut.code).not.toBe(0);
      expect(heldOut.stdout + heldOut.stderr).toContain("cleanupCompleted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("known-correct implementation passes the held-out transition", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fx-lifecycle-correct-"));
    try {
      writeLifecycleFixture(dir, "correct");
      const visible = await runBunTestFile(dir, "pool.test.ts");
      expect(visible.code).toBe(0);

      writeHeldOutLifecycleVerifier(dir);
      const heldOut = await runBunTestFile(dir, "held-out-lifecycle.test.ts");
      expect(heldOut.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("agent prompt stays generic and does not expose the held-out implementation", () => {
    expect(LIFECYCLE_TASK_PROMPT).toContain("asynchronous cleanup has settled");
    expect(LIFECYCLE_TASK_PROMPT).not.toMatch(/asyncio|python|semaphore|sigint/i);
    expect(LIFECYCLE_TASK_PROMPT).not.toContain("held-out-lifecycle.test.ts");
  });
});

describe("composed lifecycle A/B harness", () => {
  test("alternates baseline and candidate execution order", () => {
    expect(comparisonOrder(0)).toEqual(["baseline", "candidate"]);
    expect(comparisonOrder(1)).toEqual(["candidate", "baseline"]);
  });
});

const hasLiveConfig = Boolean(
  process.env.FX_LIFECYCLE_AB_BASELINE_BIN &&
    process.env.FX_LIFECYCLE_AB_CANDIDATE_BIN &&
    process.env.FX_LIFECYCLE_AB_MODEL &&
    (process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN),
);
const liveTest = hasLiveConfig ? test : test.skip;

describe("composed lifecycle live comparison", () => {
  liveTest(
    "compares configured baseline and candidate binaries",
    async () => {
      await runLifecycleComparison(loadLifecycleComparisonConfig());
    },
    30 * 60 * 1000,
  );
});
