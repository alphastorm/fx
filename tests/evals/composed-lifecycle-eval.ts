/**
 * Held-out model-backed A/B for composed lifecycle verification.
 *
 * Deterministic fixture proof:
 *   bun test composed-lifecycle-eval.test.ts
 *
 * Live comparison:
 *   FX_LIFECYCLE_AB_BASELINE_BIN=/absolute/baseline \
 *   FX_LIFECYCLE_AB_CANDIDATE_BIN=/absolute/candidate \
 *   FX_LIFECYCLE_AB_MODEL=provider/model \
 *   bun test composed-lifecycle-eval.test.ts
 */
import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { HeadlessResult } from "./eval-helpers";

export const LIFECYCLE_TASK_PROMPT = `Repair the bounded task pool in this workspace.

Its public contract is:
- no more than the configured number of jobs run concurrently;
- aborting prevents jobs that have not started from starting;
- the pool rejects with the abort reason only after asynchronous cleanup has settled for every job that did start;
- successful results preserve input order.

Inspect pool.ts and pool.test.ts. Fix the implementation, add a regression test for any missing interaction you find, and run the focused tests. Do not look for or create hidden tests.`;

export type FixtureImplementation = "flawed" | "correct";
export type ComparisonSide = "baseline" | "candidate";

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
  trials: number;
  outputDir: string;
  timeoutMs: number;
}

export interface LifecycleTrialResult {
  side: ComparisonSide;
  trialIndex: number;
  orderIndex: number;
  binaryPath: string;
  binarySha256: string;
  versionOutput: string;
  workspace: string;
  preflight: ProcessResult;
  fx: ProcessResult;
  fxJson?: HeadlessResult;
  visible: ProcessResult;
  heldOut: ProcessResult;
  passed: boolean;
  reason: string;
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
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, type: "module" }, null, 2) + "\n",
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
  );
  writeFileSync(
    join(dir, "pool.ts"),
    implementation === "flawed" ? FLAWED_POOL_SOURCE : CORRECT_POOL_SOURCE,
  );
  writeFileSync(join(dir, "pool.test.ts"), VISIBLE_TEST_SOURCE);
}

export function writeHeldOutLifecycleVerifier(dir: string): string {
  const path = join(dir, "held-out-lifecycle.test.ts");
  if (existsSync(path)) {
    throw new Error(`held-out verifier already exists: ${path}`);
  }
  writeFileSync(path, HELD_OUT_TEST_SOURCE);
  return path;
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
  const trials = Number(env.FX_LIFECYCLE_AB_TRIALS ?? "3");
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error("FX_LIFECYCLE_AB_TRIALS must be a positive integer");
  }
  const timeoutMs = Number(env.FX_LIFECYCLE_AB_TIMEOUT_MS ?? "300000");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("FX_LIFECYCLE_AB_TIMEOUT_MS must be positive");
  }

  return {
    baselineBin,
    candidateBin,
    model,
    trials,
    outputDir: env.FX_LIFECYCLE_AB_OUTPUT_DIR ??
      mkdtempSync(join(tmpdir(), "fx-composed-lifecycle-ab-")),
    timeoutMs,
  };
}

export async function runLifecycleComparison(
  config = loadLifecycleComparisonConfig(),
): Promise<void> {
  mkdirSync(config.outputDir, { recursive: true });
  const trials: LifecycleTrialResult[] = [];

  for (let trialIndex = 0; trialIndex < config.trials; trialIndex += 1) {
    for (const [orderIndex, side] of comparisonOrder(trialIndex).entries()) {
      const trial = await runLifecycleTrial(config, side, trialIndex, orderIndex);
      trials.push(trial);
    }
  }

  const baselinePasses = trials.filter(
    (trial) => trial.side === "baseline" && trial.passed,
  ).length;
  const candidatePasses = trials.filter(
    (trial) => trial.side === "candidate" && trial.passed,
  ).length;
  const summary = {
    model: config.model,
    trials: config.trials,
    baselineBin: config.baselineBin,
    candidateBin: config.candidateBin,
    baselinePasses,
    candidatePasses,
    observedDelta: candidatePasses - baselinePasses,
    results: trials.map(({ side, trialIndex, orderIndex, passed, reason, workspace }) => ({
      side,
      trialIndex,
      orderIndex,
      passed,
      reason,
      workspace,
    })),
  };
  writeFileSync(
    join(config.outputDir, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );

  console.log(`Composed lifecycle A/B artifacts: ${config.outputDir}`);
  console.log(
    `baseline ${baselinePasses}/${config.trials}, candidate ${candidatePasses}/${config.trials}`,
  );
}

async function runLifecycleTrial(
  config: LifecycleComparisonConfig,
  side: ComparisonSide,
  trialIndex: number,
  orderIndex: number,
): Promise<LifecycleTrialResult> {
  const binaryPath = side === "baseline" ? config.baselineBin : config.candidateBin;
  const workspace = join(config.outputDir, `trial-${trialIndex}`, `${orderIndex}-${side}`);
  writeLifecycleFixture(workspace, "flawed");
  const preflight = await runBunTestFile(workspace, "pool.test.ts");
  if (preflight.code !== 0) {
    throw new Error(`invalid lifecycle fixture: ${preflight.stderr || preflight.stdout}`);
  }
  if (existsSync(join(workspace, "held-out-lifecycle.test.ts"))) {
    throw new Error("held-out verifier became visible before the fx run");
  }

  const home = createEvalHome();
  let fx: ProcessResult;
  try {
    fx = await runProcess(
      binaryPath,
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
        timeoutMs: config.timeoutMs + 10_000,
        env: {
          ...process.env,
          HOME: home,
          NO_COLOR: "1",
          FX_MODEL: config.model,
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

  const heldOutPath = join(workspace, "held-out-lifecycle.test.ts");
  const agentCreatedHeldOut = existsSync(heldOutPath);
  if (agentCreatedHeldOut) {
    rmSync(heldOutPath, { recursive: true, force: true });
  }
  writeHeldOutLifecycleVerifier(workspace);
  const visible = await runBunTestFile(workspace, "pool.test.ts");
  const heldOut = await runBunTestFile(workspace, "held-out-lifecycle.test.ts");
  const reasons: string[] = [];
  if (agentCreatedHeldOut) reasons.push("agent created the reserved held-out verifier path");
  if (fx.timedOut) reasons.push("fx process timed out");
  if (fx.code !== 0) reasons.push(`fx process exited ${fx.code}`);
  if (!fxJson) reasons.push("fx JSON output could not be parsed");
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
    binaryPath,
    binarySha256: createHash("sha256").update(readFileSync(binaryPath)).digest("hex"),
    versionOutput: await versionFor(binaryPath),
    workspace,
    preflight,
    fx,
    fxJson,
    visible,
    heldOut,
    passed: reasons.length === 0,
    reason: reasons.length === 0 ? "passed" : reasons.join("; "),
  };
  writeFileSync(
    join(workspace, "trial-result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return result;
}

function createEvalHome(): string {
  const home = mkdtempSync(join(tmpdir(), "fx-composed-lifecycle-home-"));
  mkdirSync(join(home, ".fx"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, ".fx", "settings.json"),
    JSON.stringify({
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
}

async function versionFor(binaryPath: string): Promise<string> {
  const result = await runProcess(binaryPath, ["--version"], {
    cwd: process.cwd(),
    timeoutMs: 15_000,
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
