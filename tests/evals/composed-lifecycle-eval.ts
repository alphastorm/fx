/**
 * Held-out model-backed A/B for composed lifecycle verification.
 *
 * Deterministic fixture proof:
 *   bun test composed-lifecycle-eval.test.ts
 *
 * Live comparison, reported as a directional signal rather than a CI gate:
 *   FX_LIFECYCLE_AB_BASELINE_BIN=/absolute/baseline \
 *   FX_LIFECYCLE_AB_CANDIDATE_BIN=/absolute/candidate \
 *   FX_LIFECYCLE_AB_MODEL=provider/model \
 *   FX_LIFECYCLE_AB_EFFORT=high \
 *   FX_LIFECYCLE_AB_USE_FX_LOGIN=1 \
 *   bun test composed-lifecycle-eval.test.ts
 */
import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { HAS_API_KEY, type HeadlessResult } from "./eval-helpers";

export const LIFECYCLE_TASK_PROMPT = `Repair the bounded task pool in this workspace.

Its public contract is:
- no more than the configured number of jobs run concurrently;
- aborting prevents jobs that have not started from starting;
- the pool rejects with the abort reason only after asynchronous cleanup has settled for every job that did start;
- successful results preserve input order.

Inspect pool.ts and pool.test.ts. Fix the implementation, add a regression test for any missing interaction you find, and run the focused tests. Do not look for or create hidden tests.`;

export const MAX_LIFECYCLE_AB_TRIALS = 10;
export const MAX_LIFECYCLE_AB_TIMEOUT_MS = 15 * 60 * 1000;
export function lifecycleHasLiveCredential(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const hasEnvironmentCredential = env === process.env
    ? HAS_API_KEY
    : Boolean(env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN);
  return hasEnvironmentCredential ||
    env.FX_LIFECYCLE_AB_USE_FX_LOGIN === "1";
}
export const FINAL_VERIFICATION_TRACE_EVENT = "event=final_verification_injected";

const PROCESS_TIMEOUT_GRACE_MS = 10_000;
const BUN_TEST_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 15_000;
const COMPARISON_TIMEOUT_GRACE_MS = 60_000;
const MAX_LIFECYCLE_SOURCE_BYTES = 256 * 1024;

export type FixtureImplementation = "flawed" | "correct";
export type ComparisonSide = "baseline" | "candidate";
export type LifecycleCredentialMode = "environment" | "fx-login";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface LifecycleComparisonConfig {
  baselineBin: string;
  candidateBin: string;
  model: string;
  effort: string;
  credentialMode: LifecycleCredentialMode;
  trials: number;
  outputDir: string;
  timeoutMs: number;
}

export interface BinarySnapshot {
  sourcePath: string;
  path: string;
  sha256: string;
  versionOutput: string;
}

export interface LifecycleTrialResult {
  side: ComparisonSide;
  trialIndex: number;
  orderIndex: number;
  binaryPath: string;
  binarySha256: string;
  versionOutput: string;
  workspace: string;
  verifierWorkspace: string;
  verificationInjected: boolean;
  preflight: ProcessResult;
  fx: ProcessResult;
  fxJson?: HeadlessResult;
  visible: ProcessResult;
  heldOut: ProcessResult;
  passed: boolean;
  reason: string;
}

export interface LifecycleComparisonSummary {
  complete: boolean;
  model: string;
  effort: string;
  credentialMode: LifecycleCredentialMode;
  trials: number;
  expectedTrialResults: number;
  completedTrialResults: number;
  binaries: Record<ComparisonSide, BinarySnapshot>;
  baselinePasses: number;
  candidatePasses: number;
  observedDelta: number;
  interpretation: string;
  results: Array<{
    side: ComparisonSide;
    trialIndex: number;
    orderIndex: number;
    passed: boolean;
    reason: string;
    workspace: string;
  }>;
}

const FLAWED_POOL_SOURCE = `export interface PoolJob<T> {
  run(signal: AbortSignal): Promise<T>;
  cleanup(): Promise<void>;
}


export async function runBounded<T>(
  jobs: readonly PoolJob<T>[],
  limit: number,
  signal: AbortSignal,
): Promise<T[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("limit must be a positive integer");
  }

  const results = new Array<T>(jobs.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      const index = nextIndex;
      if (index >= jobs.length) return;
      nextIndex += 1;

      const job = jobs[index]!;
      try {
        results[index] = await job.run(signal);
      } finally {
        await job.cleanup();
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, () => worker()),
  );
  return results;
}
`;

const CORRECT_POOL_SOURCE = `export interface PoolJob<T> {
  run(signal: AbortSignal): Promise<T>;
  cleanup(): Promise<void>;
}


export async function runBounded<T>(
  jobs: readonly PoolJob<T>[],
  limit: number,
  signal: AbortSignal,
): Promise<T[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("limit must be a positive integer");
  }

  const results = new Array<T>(jobs.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      const index = nextIndex;
      if (index >= jobs.length) return;
      nextIndex += 1;

      const job = jobs[index]!;
      try {
        results[index] = await job.run(signal);
      } finally {
        await job.cleanup();
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(limit, jobs.length) },
    () => worker(),
  );
  const outcomes = await Promise.allSettled(workers);
  const failure = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  if (failure) throw failure.reason;
  return results;
}
`;

const VISIBLE_TEST_SOURCE = `import { describe, expect, test } from "bun:test";
import { runBounded, type PoolJob } from "./pool";

function waitForAbort(signal: AbortSignal): Promise<never> {
  const { promise, reject } = Promise.withResolvers<never>();
  const rejectAbort = () => reject(signal.reason);
  if (signal.aborted) {
    rejectAbort();
  } else {
    signal.addEventListener("abort", rejectAbort, { once: true });
  }
  return promise;
}

describe("runBounded", () => {
  test("limits concurrency and preserves result order", async () => {
    let active = 0;
    let maxActive = 0;
    const jobs: PoolJob<number>[] = Array.from({ length: 5 }, (_, index) => ({
      async run() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(5 + (4 - index));
        active -= 1;
        return index;
      },
      async cleanup() {},
    }));

    const results = await runBounded(jobs, 2, new AbortController().signal);

    expect(maxActive).toBe(2);
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  test("abort prevents queued work from starting", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const started: number[] = [];
    const { promise: firstStarted, resolve: announceStarted } =
      Promise.withResolvers<void>();
    const jobs: PoolJob<number>[] = [0, 1].map((index) => ({
      async run(signal) {
        started.push(index);
        if (index === 0) announceStarted();
        return waitForAbort(signal);
      },
      async cleanup() {},
    }));

    const running = runBounded(jobs, 1, controller.signal);
    await firstStarted;
    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(started).toEqual([0]);
  });

  test("normal completion awaits asynchronous cleanup", async () => {
    let cleanupComplete = false;
    const jobs: PoolJob<number>[] = [{
      async run() {
        return 42;
      },
      async cleanup() {
        await Bun.sleep(10);
        cleanupComplete = true;
      },
    }];

    await expect(
      runBounded(jobs, 1, new AbortController().signal),
    ).resolves.toEqual([42]);
    expect(cleanupComplete).toBe(true);
  });
});
`;

const HELD_OUT_TEST_SOURCE = `import { expect, test } from "bun:test";
import { runBounded, type PoolJob } from "./pool";

function waitForAbort(signal: AbortSignal): Promise<never> {
  const { promise, reject } = Promise.withResolvers<never>();
  const rejectAbort = () => reject(signal.reason);
  if (signal.aborted) {
    rejectAbort();
  } else {
    signal.addEventListener("abort", rejectAbort, { once: true });
  }
  return promise;
}

test("queued abort settles cleanup for every started job before rejection", async () => {
  const controller = new AbortController();
  const reason = new Error("interrupt");
  const started: number[] = [];
  const cleanupCompleted: number[] = [];
  const { promise: bothStarted, resolve: announceBothStarted } =
    Promise.withResolvers<void>();

  const jobs: PoolJob<number>[] = [0, 1, 2].map((index) => ({
    async run(signal) {
      started.push(index);
      if (started.length === 2) announceBothStarted();
      return waitForAbort(signal);
    },
    async cleanup() {
      if (index < 2) await Bun.sleep(index === 0 ? 5 : 80);
      cleanupCompleted.push(index);
    },
  }));

  const running = runBounded(jobs, 2, controller.signal);
  await Promise.race([
    bothStarted,
    Bun.sleep(1_000).then(() => {
      throw new Error("timed out waiting for two started jobs");
    }),
  ]);
  controller.abort(reason);

  await expect(running).rejects.toBe(reason);
  expect(started.sort()).toEqual([0, 1]);
  expect(cleanupCompleted.sort()).toEqual([0, 1]);
});
`;

export function writeLifecycleFixture(
  dir: string,
  implementation: FixtureImplementation,
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, type: "module" }, null, 2) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          types: ["bun"],
          noEmit: true,
        },
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    join(dir, "pool.ts"),
    implementation === "flawed" ? FLAWED_POOL_SOURCE : CORRECT_POOL_SOURCE,
    { mode: 0o600 },
  );
  writeFileSync(join(dir, "pool.test.ts"), VISIBLE_TEST_SOURCE, {
    mode: 0o600,
  });
}

export function writeHeldOutLifecycleVerifier(dir: string): string {
  const path = join(dir, "held-out-lifecycle.test.ts");
  if (existsSync(path)) {
    throw new Error(`held-out verifier already exists: ${path}`);
  }
  writeFileSync(path, HELD_OUT_TEST_SOURCE, { mode: 0o600 });
  return path;
}

export function prepareHeldOutLifecycleWorkspace(
  agentWorkspace: string,
  verifierWorkspace: string,
): string {
  rmSync(verifierWorkspace, { recursive: true, force: true });
  writeLifecycleFixture(verifierWorkspace, "flawed");
  const agentPoolPath = join(agentWorkspace, "pool.ts");
  let agentPoolFd: number;
  try {
    agentPoolFd = openSync(
      agentPoolPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new Error("agent pool.ts must be a regular file", { cause: error });
  }
  const verifierPoolPath = join(verifierWorkspace, "pool.ts");
  try {
    const sourceStat = fstatSync(agentPoolFd);
    if (!sourceStat.isFile()) {
      throw new Error("agent pool.ts must be a regular file");
    }
    if (sourceStat.size > MAX_LIFECYCLE_SOURCE_BYTES) {
      throw new Error(
        `agent pool.ts exceeds ${MAX_LIFECYCLE_SOURCE_BYTES}-byte verifier limit`,
      );
    }
    const source = readFileSync(agentPoolFd);
    if (source.byteLength > MAX_LIFECYCLE_SOURCE_BYTES) {
      throw new Error(
        `agent pool.ts exceeds ${MAX_LIFECYCLE_SOURCE_BYTES}-byte verifier limit`,
      );
    }
    writeFileSync(verifierPoolPath, source, { mode: 0o600 });
  } finally {
    closeSync(agentPoolFd);
  }
  chmodSync(verifierPoolPath, 0o600);
  return writeHeldOutLifecycleVerifier(verifierWorkspace);
}

export function redactKnownSecrets(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let redacted = text;
  for (const key of ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"]) {
    const value = env[key];
    if (!value) continue;
    redacted = redacted.split(value).join(`[redacted:${key}]`);
  }
  return redacted;
}

export async function runBunTestFile(
  dir: string,
  file: string,
  timeoutMs = 30_000,
): Promise<ProcessResult> {
  return runProcess("bun", ["test", file], { cwd: dir, timeoutMs });
}

export function comparisonOrder(
  trialIndex: number,
): [ComparisonSide, ComparisonSide] {
  return trialIndex % 2 === 0
    ? ["baseline", "candidate"]
    : ["candidate", "baseline"];
}

export function requireExecutableBinary(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`${label} binary must be an absolute path, got ${path}`);
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} binary does not exist: ${path}`);
  }
  if ((statSync(path).mode & 0o111) === 0) {
    throw new Error(`${label} binary is not executable: ${path}`);
  }
  return path;
}

export function loadLifecycleComparisonConfig(
  env: NodeJS.ProcessEnv = process.env,
): LifecycleComparisonConfig {
  const baselineBin = requireExecutableBinary(
    env.FX_LIFECYCLE_AB_BASELINE_BIN ?? "",
    "baseline",
  );
  const candidateBin = requireExecutableBinary(
    env.FX_LIFECYCLE_AB_CANDIDATE_BIN ?? "",
    "candidate",
  );
  const model = env.FX_LIFECYCLE_AB_MODEL;
  if (!model) throw new Error("FX_LIFECYCLE_AB_MODEL is required");
  const effort = env.FX_LIFECYCLE_AB_EFFORT?.trim() || "high";
  const credentialMode: LifecycleCredentialMode =
    env.FX_LIFECYCLE_AB_USE_FX_LOGIN === "1" ? "fx-login" : "environment";
  const trials = Number(env.FX_LIFECYCLE_AB_TRIALS ?? "3");
  if (
    !Number.isInteger(trials) ||
    trials < 1 ||
    trials > MAX_LIFECYCLE_AB_TRIALS
  ) {
    throw new Error(
      `FX_LIFECYCLE_AB_TRIALS must be an integer from 1 to ${MAX_LIFECYCLE_AB_TRIALS}`,
    );
  }
  const timeoutMs = Number(env.FX_LIFECYCLE_AB_TIMEOUT_MS ?? "300000");
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_LIFECYCLE_AB_TIMEOUT_MS
  ) {
    throw new Error(
      `FX_LIFECYCLE_AB_TIMEOUT_MS must be an integer from 1 to ${MAX_LIFECYCLE_AB_TIMEOUT_MS}`,
    );
  }

  return {
    baselineBin,
    candidateBin,
    model,
    effort,
    credentialMode,
    trials,
    outputDir: env.FX_LIFECYCLE_AB_OUTPUT_DIR ??
      mkdtempSync(join(tmpdir(), "fx-composed-lifecycle-ab-")),
    timeoutMs,
  };
}

export function comparisonTimeoutMs(config: LifecycleComparisonConfig): number {
  const perTrialResult =
    config.timeoutMs +
    PROCESS_TIMEOUT_GRACE_MS +
    BUN_TEST_TIMEOUT_MS * 3 +
    VERSION_TIMEOUT_MS;
  return config.trials * 2 * perTrialResult + COMPARISON_TIMEOUT_GRACE_MS;
}

export async function runLifecycleComparison(
  config = loadLifecycleComparisonConfig(),
): Promise<LifecycleComparisonSummary> {
  mkdirSync(config.outputDir, { recursive: true, mode: 0o700 });
  chmodSync(config.outputDir, 0o700);
  const binaries: Record<ComparisonSide, BinarySnapshot> = {
    baseline: await snapshotBinary(config.outputDir, "baseline", config.baselineBin),
    candidate: await snapshotBinary(config.outputDir, "candidate", config.candidateBin),
  };
  if (binaries.baseline.sha256 === binaries.candidate.sha256) {
    throw new Error(
      "baseline and candidate binaries are byte-identical; no A/B treatment exists",
    );
  }

  const trialResults: LifecycleTrialResult[] = [];
  let summary = writeComparisonSummary(config, binaries, trialResults, false);
  for (let trialIndex = 0; trialIndex < config.trials; trialIndex += 1) {
    for (const [orderIndex, side] of comparisonOrder(trialIndex).entries()) {
      const trial = await runLifecycleTrial(
        config,
        binaries[side],
        side,
        trialIndex,
        orderIndex,
      );
      trialResults.push(trial);
      summary = writeComparisonSummary(config, binaries, trialResults, false);
    }
  }
  summary = writeComparisonSummary(config, binaries, trialResults, true);

  console.log(`Composed lifecycle A/B artifacts: ${config.outputDir}`);
  console.log(
    `baseline ${summary.baselinePasses}/${config.trials}, candidate ${summary.candidatePasses}/${config.trials}`,
  );
  return summary;
}

async function snapshotBinary(
  outputDir: string,
  side: ComparisonSide,
  sourcePath: string,
): Promise<BinarySnapshot> {
  const snapshotDir = join(outputDir, "binaries");
  mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
  chmodSync(snapshotDir, 0o700);
  const path = join(snapshotDir, side);
  rmSync(path, { force: true });
  copyFileSync(sourcePath, path);
  chmodSync(path, 0o500);
  const bytes = readFileSync(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    sourcePath,
    path,
    sha256,
    versionOutput: await versionFor(path),
  };
}

function writeComparisonSummary(
  config: LifecycleComparisonConfig,
  binaries: Record<ComparisonSide, BinarySnapshot>,
  trialResults: LifecycleTrialResult[],
  complete: boolean,
): LifecycleComparisonSummary {
  const baselinePasses = trialResults.filter(
    (trial) => trial.side === "baseline" && trial.passed,
  ).length;
  const candidatePasses = trialResults.filter(
    (trial) => trial.side === "candidate" && trial.passed,
  ).length;
  const summary: LifecycleComparisonSummary = {
    complete,
    model: config.model,
    effort: config.effort,
    credentialMode: config.credentialMode,
    trials: config.trials,
    expectedTrialResults: config.trials * 2,
    completedTrialResults: trialResults.length,
    binaries,
    baselinePasses,
    candidatePasses,
    observedDelta: candidatePasses - baselinePasses,
    interpretation:
      "Directional model-backed signal only; inspect paired artifacts and do not treat a small delta as a deterministic gate.",
    results: trialResults.map(
      ({ side, trialIndex, orderIndex, passed, reason, workspace }) => ({
        side,
        trialIndex,
        orderIndex,
        passed,
        reason,
        workspace,
      }),
    ),
  };
  writeFileSync(
    join(config.outputDir, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
    { mode: 0o600 },
  );
  return summary;
}

async function runLifecycleTrial(
  config: LifecycleComparisonConfig,
  binary: BinarySnapshot,
  side: ComparisonSide,
  trialIndex: number,
  orderIndex: number,
): Promise<LifecycleTrialResult> {
  const binaryHashBefore = createHash("sha256")
    .update(readFileSync(binary.path))
    .digest("hex");
  if (binaryHashBefore !== binary.sha256) {
    throw new Error(`${side} binary snapshot changed before trial ${trialIndex}`);
  }

  const workspace = join(config.outputDir, `trial-${trialIndex}`, `${orderIndex}-${side}`);
  const verifierWorkspace = `${workspace}-held-out`;
  const traceDir = join(config.outputDir, "traces");
  mkdirSync(traceDir, { recursive: true, mode: 0o700 });
  chmodSync(traceDir, 0o700);
  const tracePath = join(traceDir, `trial-${trialIndex}-${orderIndex}-${side}.log`);
  rmSync(tracePath, { force: true });
  writeLifecycleFixture(workspace, "flawed");
  const preflight = await runBunTestFile(workspace, "pool.test.ts");
  if (preflight.code !== 0) {
    throw new Error(`invalid lifecycle fixture: ${preflight.stderr || preflight.stdout}`);
  }
  if (existsSync(join(workspace, "held-out-lifecycle.test.ts"))) {
    throw new Error("held-out verifier became visible before the fx run");
  }

  const home = createLifecycleEvalHome(
    config.effort,
    config.credentialMode,
  );
  let fx: ProcessResult;
  try {
    fx = await runProcess(
      binary.path,
      [
        "ask",
        "--auto",
        "--json",
        "--no-save",
        "--timeout",
        String(config.timeoutMs),
        LIFECYCLE_TASK_PROMPT,
      ],
      {
        cwd: workspace,
        timeoutMs: config.timeoutMs + PROCESS_TIMEOUT_GRACE_MS,
        env: {
          ...process.env,
          HOME: home,
          NO_COLOR: "1",
          FX_AUTO_UPGRADE: "0",
          FX_MAX_AGENT_STEPS: "100",
          FX_MODEL: config.model,
          FX_PERMISSION_MODE: "auto",
          FX_SKIP_ONBOARDING: "1",
          FX_TRACE_LOG: tracePath,
          FX_TRACE_SCOPES: "agent",
        },
      },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  let fxJson: HeadlessResult | undefined;
  try {
    fxJson = JSON.parse(fx.stdout.trim()) as HeadlessResult;
  } catch {}

  const agentHeldOutPath = join(workspace, "held-out-lifecycle.test.ts");
  const agentCreatedHeldOut = existsSync(agentHeldOutPath);
  if (agentCreatedHeldOut) {
    rmSync(agentHeldOutPath, { recursive: true, force: true });
  }
  const visible = await runBunTestFile(workspace, "pool.test.ts");
  let heldOut: ProcessResult;
  try {
    prepareHeldOutLifecycleWorkspace(workspace, verifierWorkspace);
    heldOut = await runBunTestFile(
      verifierWorkspace,
      "held-out-lifecycle.test.ts",
    );
  } catch (error) {
    heldOut = {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: null,
      signal: null,
      timedOut: false,
    };
  }

  let trace = "";
  if (existsSync(tracePath)) {
    trace = redactKnownSecrets(readFileSync(tracePath, "utf8"));
    writeFileSync(tracePath, trace);
    chmodSync(tracePath, 0o600);
  }
  const verificationInjected = trace.includes(FINAL_VERIFICATION_TRACE_EVENT);
  const binaryHashAfter = createHash("sha256")
    .update(readFileSync(binary.path))
    .digest("hex");
  const reasons: string[] = [];
  if (agentCreatedHeldOut) reasons.push("agent created the reserved held-out verifier path");
  if (binaryHashAfter !== binary.sha256) reasons.push("binary snapshot changed during trial");
  if (side === "candidate" && !verificationInjected) {
    reasons.push("candidate did not inject final verification after mutation");
  }
  if (side === "baseline" && verificationInjected) {
    reasons.push("baseline unexpectedly injected final verification");
  }
  if (fx.timedOut) reasons.push("fx process timed out");
  if (fx.code !== 0) reasons.push(`fx process exited ${fx.code}`);
  if (!fxJson) reasons.push("fx JSON output could not be parsed");
  if (fxJson?.error) reasons.push(`fx reported error ${fxJson.error}`);
  if (fxJson && fxJson.exit_code !== 0) {
    reasons.push(`fx reported exit_code ${fxJson.exit_code}`);
  }
  if (fxJson && fxJson.model !== config.model) {
    reasons.push(`fx reported model ${fxJson.model}`);
  }
  if (visible.code !== 0) reasons.push("visible tests failed after the agent run");
  if (heldOut.code !== 0) reasons.push("held-out composed lifecycle verifier failed");

  const result: LifecycleTrialResult = {
    side,
    trialIndex,
    orderIndex,
    binaryPath: binary.path,
    binarySha256: binary.sha256,
    versionOutput: binary.versionOutput,
    workspace,
    verifierWorkspace,
    verificationInjected,
    preflight,
    fx,
    fxJson,
    visible,
    heldOut,
    passed: reasons.length === 0,
    reason: reasons.length === 0 ? "passed" : reasons.join("; "),
  };
  const artifact = redactKnownSecrets(
    JSON.stringify(result, null, 2) + "\n",
  );
  writeFileSync(join(workspace, "trial-result.json"), artifact, {
    mode: 0o600,
  });
  return result;
}

export function createLifecycleEvalHome(
  effort: string,
  credentialMode: LifecycleCredentialMode,
  sourceHome: string | undefined = process.env.HOME,
): string {
  const home = mkdtempSync(join(tmpdir(), "fx-composed-lifecycle-home-"));
  try {
    mkdirSync(join(home, ".fx"), { recursive: true, mode: 0o700 });
    if (credentialMode === "fx-login") {
      if (process.platform !== "darwin") {
        throw new Error("Fx login A/B authentication requires macOS Keychain");
      }
      if (!sourceHome) {
        throw new Error("Fx login A/B authentication requires HOME");
      }
      const sourceKeychains = join(sourceHome, "Library", "Keychains");
      if (!statSync(sourceKeychains).isDirectory()) {
        throw new Error("Fx login A/B authentication requires a Keychains directory");
      }
      mkdirSync(join(home, "Library"), { mode: 0o700 });
      symlinkSync(
        sourceKeychains,
        join(home, "Library", "Keychains"),
        "dir",
      );
    }
    writeFileSync(
      join(home, ".fx", "settings.json"),
      JSON.stringify({
        effort,
        fast_mode: false,
        permission_mode: "auto",
        permission: {
          bash: "allow",
          edit: "allow",
          read: "allow",
          write: "allow",
        },
      }) + "\n",
      { mode: 0o600 },
    );
    return home;
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

async function versionFor(binaryPath: string): Promise<string> {
  const result = await runProcess(binaryPath, ["--version"], {
    cwd: process.cwd(),
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  return (result.stdout || result.stderr).trim() || `exit ${result.code}`;
}

async function runProcess(
  command: string,
  args: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<ProcessResult> {
  const { promise, resolve } = Promise.withResolvers<ProcessResult>();
  const child = nodeSpawn(command, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let timedOut = false;
  let settled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, opts.timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
      code,
      signal,
      timedOut,
    });
  };
  child.on("error", (error) => {
    stderr.push(Buffer.from(error.message));
    finish(null, null);
  });
  child.on("close", finish);
  return promise;
}
