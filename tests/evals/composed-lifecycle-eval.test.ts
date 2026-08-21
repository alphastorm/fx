import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLifecycleEvalHome,
  LIFECYCLE_TASK_PROMPT,
  MAX_LIFECYCLE_AB_TRIALS,
  comparisonOrder,
  comparisonTimeoutMs,
  loadLifecycleComparisonConfig,
  lifecycleHasLiveCredential,
  prepareHeldOutLifecycleWorkspace,
  redactKnownSecrets,
  runBunTestFile,
  runLifecycleComparison,
  writeHeldOutLifecycleVerifier,
  writeLifecycleFixture,
  type LifecycleComparisonConfig,
} from "./composed-lifecycle-eval";

const darwinTest = test.skipIf(process.platform !== "darwin");

describe("composed lifecycle fixture", () => {
  test("frozen flaw passes visible tests and fails the held-out transition", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fx-lifecycle-flawed-"));
    try {
      writeLifecycleFixture(dir, "flawed");
      expect(existsSync(join(dir, "held-out-lifecycle.test.ts"))).toBe(false);
      expect(statSync(dir).mode & 0o777).toBe(0o700);

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

  test("held-out verifier ignores agent-controlled Bun configuration", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "fx-lifecycle-agent-"));
    const verifierDir = mkdtempSync(join(tmpdir(), "fx-lifecycle-verifier-"));
    try {
      writeLifecycleFixture(agentDir, "flawed");
      writeFileSync(join(agentDir, "bunfig.toml"), "[test]\npreload = [\"./preload.ts\"]\n");
      writeFileSync(join(agentDir, "preload.ts"), "throw new Error(\"agent preload ran\");\n");

      prepareHeldOutLifecycleWorkspace(agentDir, verifierDir);

      expect(existsSync(join(verifierDir, "bunfig.toml"))).toBe(false);
      const heldOut = await runBunTestFile(
        verifierDir,
        "held-out-lifecycle.test.ts",
      );
      expect(heldOut.code).not.toBe(0);
      expect(heldOut.stdout + heldOut.stderr).not.toContain("agent preload ran");
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(verifierDir, { recursive: true, force: true });
    }
  });

  test("held-out verifier rejects symlinked agent source", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "fx-lifecycle-agent-"));
    const verifierDir = mkdtempSync(join(tmpdir(), "fx-lifecycle-verifier-"));
    try {
      writeLifecycleFixture(agentDir, "flawed");
      const externalPath = join(agentDir, "external.ts");
      writeFileSync(externalPath, "export const exposed = true;\n");
      rmSync(join(agentDir, "pool.ts"));
      symlinkSync(externalPath, join(agentDir, "pool.ts"));

      expect(() =>
        prepareHeldOutLifecycleWorkspace(agentDir, verifierDir)
      ).toThrow(/regular file/);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(verifierDir, { recursive: true, force: true });
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

  test("recognizes explicit Fx login authentication", () => {
    expect(
      lifecycleHasLiveCredential({
        FX_LIFECYCLE_AB_USE_FX_LOGIN: "1",
      }),
    ).toBe(true);
  });

  darwinTest("isolates settings while linking the login keychain", () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "fx-lifecycle-source-home-"));
    mkdirSync(join(sourceHome, "Library", "Keychains"), {
      recursive: true,
      mode: 0o700,
    });
    const evalHome = createLifecycleEvalHome(
      "high",
      "fx-login",
      sourceHome,
    );
    try {
      expect(
        lstatSync(join(evalHome, "Library", "Keychains")).isSymbolicLink(),
      ).toBe(true);
      expect(
        readFileSync(join(evalHome, ".fx", "settings.json"), "utf8"),
      ).toContain("\"effort\":\"high\"");
    } finally {
      rmSync(evalHome, { recursive: true, force: true });
      rmSync(sourceHome, { recursive: true, force: true });
    }
  });

  test("bounds aggregate model-backed trials", () => {
    expect(() =>
      loadLifecycleComparisonConfig({
        FX_LIFECYCLE_AB_BASELINE_BIN: process.execPath,
        FX_LIFECYCLE_AB_CANDIDATE_BIN: process.execPath,
        FX_LIFECYCLE_AB_MODEL: "provider/model",
        FX_LIFECYCLE_AB_TRIALS: String(MAX_LIFECYCLE_AB_TRIALS + 1),
      })
    ).toThrow(/integer from 1/);
  });

  test("derives a comparison timeout from every bounded subprocess", () => {
    const config: LifecycleComparisonConfig = {
      baselineBin: process.execPath,
      candidateBin: process.execPath,
      model: "provider/model",
      effort: "high",
      credentialMode: "environment",
      trials: 1,
      outputDir: "/tmp/unused",
      timeoutMs: 1_000,
    };

    expect(comparisonTimeoutMs(config)).toBe(292_000);
  });

  test("rejects byte-identical baseline and candidate snapshots", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "fx-lifecycle-identical-"));
    try {
      const config: LifecycleComparisonConfig = {
        baselineBin: process.execPath,
        candidateBin: process.execPath,
        model: "provider/model",
        effort: "high",
        credentialMode: "environment",
        trials: 1,
        outputDir,
        timeoutMs: 1_000,
      };

      await expect(runLifecycleComparison(config)).rejects.toThrow(
        /byte-identical/,
      );
      expect(statSync(outputDir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("redacts inherited gateway credentials from persisted artifacts", () => {
    const redacted = redactKnownSecrets(
      "key=secret-key token=secret-token",
      {
        AI_GATEWAY_API_KEY: "secret-key",
        VERCEL_OIDC_TOKEN: "secret-token",
      },
    );

    expect(redacted).toBe(
      "key=[redacted:AI_GATEWAY_API_KEY] token=[redacted:VERCEL_OIDC_TOKEN]",
    );
  });
});

const hasLiveConfig = Boolean(
  process.env.FX_LIFECYCLE_AB_BASELINE_BIN &&
    process.env.FX_LIFECYCLE_AB_CANDIDATE_BIN &&
    process.env.FX_LIFECYCLE_AB_MODEL &&
    lifecycleHasLiveCredential(),
);
const liveConfig = hasLiveConfig ? loadLifecycleComparisonConfig() : undefined;
const liveTest = liveConfig ? test : test.skip;
const liveTimeoutMs = liveConfig
  ? comparisonTimeoutMs(liveConfig)
  : 30 * 60 * 1000;

describe("composed lifecycle live comparison", () => {
  liveTest(
    "compares configured baseline and candidate binaries",
    async () => {
      if (!liveConfig) throw new Error("live comparison config missing");
      await runLifecycleComparison(liveConfig);
    },
    liveTimeoutMs,
  );
});
