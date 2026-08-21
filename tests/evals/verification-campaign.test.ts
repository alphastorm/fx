import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FINAL_CASES,
  FINAL_TRIALS_PER_CASE,
  MAX_FIXTURE_FILE_BYTES,
  MAX_FIXTURE_TOTAL_BYTES,
  PILOT_CASES,
  buildFrozenManifest,
  canonicalJson,
  createPilotOrder,
  exactMcNemarP,
  pairedLiftConfidenceInterval,
  summarizePairs,
  validateFrozenManifest,
  type PairedOutcome,
  type VerificationCase,
} from "./verification-campaign";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "fx-verification-campaign-test-"));
  roots.push(root);
  return root;
}

function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function runBunTests(root: string, testFiles: readonly string[]): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const child = Bun.spawnSync(["bun", "test", ...testFiles], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

function fixtureFiles(testCase: VerificationCase, correct: boolean): Record<string, string> {
  return {
    ...testCase.initial_files,
    ...(correct ? testCase.correct_files : {}),
    ...testCase.held_out_files,
  };
}

describe("verification campaign inventory", () => {
  test("final suite has six mutation families and two read-only controls", () => {
    const mutationCases = FINAL_CASES.filter((value) => value.kind === "mutation");
    const controls = FINAL_CASES.filter((value) => value.kind === "read-only");

    expect(mutationCases).toHaveLength(6);
    expect(new Set(mutationCases.map((value) => value.family)).size).toBe(6);
    expect(controls).toHaveLength(2);
    expect(FINAL_CASES.map((value) => value.id)).toEqual([
      "bounded-pool-drain",
      "cross-file-price-contract",
      "durable-job-transition",
      "falsy-flags-roundtrip",
      "temp-resource-cleanup",
      "layered-config-precedence",
      "read-only-dependency-control",
      "read-only-default-control",
    ]);
  });

  test("pilot fixtures are separate from the final holdout", () => {
    const finalIds = new Set(FINAL_CASES.map((value) => value.id));
    expect(PILOT_CASES).toHaveLength(3);
    expect(PILOT_CASES.every((value) => value.phase === "pilot")).toBe(true);
    expect(PILOT_CASES.every((value) => !finalIds.has(value.id))).toBe(true);
  });

  test("fixture paths and byte budgets are bounded", () => {
    for (const testCase of [...PILOT_CASES, ...FINAL_CASES]) {
      let total = 0;
      const files = {
        ...testCase.initial_files,
        ...testCase.correct_files,
        ...testCase.held_out_files,
      };
      for (const [relative, content] of Object.entries(files)) {
        expect(relative.startsWith("/")).toBe(false);
        expect(relative.split("/")).not.toContain("..");
        const bytes = Buffer.byteLength(content);
        expect(bytes).toBeLessThanOrEqual(MAX_FIXTURE_FILE_BYTES);
        total += bytes;
      }
      expect(total).toBeLessThanOrEqual(MAX_FIXTURE_TOTAL_BYTES);
      for (const implementation of testCase.implementation_files) {
        expect(testCase.correct_files[implementation]).toBeDefined();
        expect(testCase.initial_files[implementation]).toBeDefined();
      }
      if (testCase.kind === "read-only") {
        expect(testCase.implementation_files).toEqual([]);
        expect(testCase.expected_output_fragments?.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("verification fixture behavior", () => {
  for (const testCase of [...PILOT_CASES, ...FINAL_CASES].filter(
    (value) => value.kind === "mutation",
  )) {
    test(`${testCase.id} has the declared initial visible-test status`, () => {
      const root = temporaryDirectory();
      writeFiles(root, testCase.initial_files);
      const result = runBunTests(root, testCase.visible_test_files);
      const expectedCode = testCase.initial_visible_passes === false ? 1 : 0;
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(expectedCode);
    });

    test(`${testCase.id} flawed implementation fails held-out coverage`, () => {
      const root = temporaryDirectory();
      writeFiles(root, fixtureFiles(testCase, false));
      const result = runBunTests(root, Object.keys(testCase.held_out_files));
      expect(result.code, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    });

    test(`${testCase.id} reference implementation passes visible and held-out coverage`, () => {
      const root = temporaryDirectory();
      writeFiles(root, fixtureFiles(testCase, true));
      const result = runBunTests(root, [
        ...testCase.visible_test_files,
        ...Object.keys(testCase.held_out_files),
      ]);
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    });
  }
});

describe("frozen manifest", () => {
  const binary = {
    path: "/tmp/fx",
    sha256: "a".repeat(64),
    version: "fx 1.0.0",
    revision: "abc123",
  };

  test("final manifest freezes all 160 balanced coordinates", () => {
    const manifest = buildFrozenManifest({
      phase: "final",
      created_at: "2026-08-21T00:00:00.000Z",
      preflight_sha256: "f".repeat(64),
      image_reference: "oven/bun@sha256:example",
      image_digest: "sha256:example",
      gateway_upstream: "https://ai-gateway.vercel.sh/v3/ai/language-model",
      model: "provider/model",
      catalog_json: '{"data":[]}',
      baseline: binary,
      candidate: { ...binary, path: "/tmp/candidate", sha256: "b".repeat(64) },
    });

    expect(manifest.trials_per_case).toBe(FINAL_TRIALS_PER_CASE);
    expect(manifest.coordinates).toHaveLength(160);
    for (const testCase of FINAL_CASES) {
      const coordinates = manifest.coordinates.filter(
        (coordinate) => coordinate.case_id === testCase.id,
      );
      expect(coordinates.filter((coordinate) => coordinate.arm === "baseline")).toHaveLength(10);
      expect(coordinates.filter((coordinate) => coordinate.arm === "candidate")).toHaveLength(10);
      expect(coordinates.filter(
        (coordinate) => coordinate.arm === "baseline" && coordinate.order_index === 0,
      )).toHaveLength(5);
      expect(coordinates.filter(
        (coordinate) => coordinate.arm === "candidate" && coordinate.order_index === 0,
      )).toHaveLength(5);
    }
    expect(() => validateFrozenManifest(manifest)).not.toThrow();
    expect(canonicalJson(manifest)).toContain('"manifest_sha256"');
  });

  test("manifest validation rejects post-freeze changes", () => {
    const manifest = buildFrozenManifest({
      phase: "pilot",
      created_at: "2026-08-21T00:00:00.000Z",
      preflight_sha256: "f".repeat(64),
      image_reference: "oven/bun@sha256:example",
      image_digest: "sha256:example",
      gateway_upstream: "https://example.invalid/chat",
      model: "provider/model",
      catalog_json: '{"data":[]}',
      baseline: binary,
      candidate: { ...binary, sha256: "b".repeat(64) },
    });
    manifest.gateway.model = "changed/model";
    expect(() => validateFrozenManifest(manifest)).toThrow("manifest hash mismatch");
  });

  test("pilot order rotates every arm through every position", () => {
    const orders = [createPilotOrder(0), createPilotOrder(1), createPilotOrder(2)];
    for (const arm of ["baseline", "instructed", "candidate"] as const) {
      expect(orders.map((order) => order.indexOf(arm)).sort()).toEqual([0, 1, 2]);
    }
  });
});

describe("paired statistics", () => {
  test("exact McNemar handles no discordance and a one-sided five-pair lift", () => {
    expect(exactMcNemarP(0, 0)).toBe(1);
    expect(exactMcNemarP(0, 5)).toBe(0.0625);
    expect(exactMcNemarP(2, 3)).toBe(1);
  });

  test("summary reports paired lift and deterministic bootstrap interval", () => {
    const pairs: PairedOutcome[] = [
      { case_id: "a", trial_index: 0, kind: "mutation", baseline_passed: false, candidate_passed: true },
      { case_id: "a", trial_index: 1, kind: "mutation", baseline_passed: false, candidate_passed: true },
      { case_id: "b", trial_index: 0, kind: "mutation", baseline_passed: true, candidate_passed: true },
      { case_id: "b", trial_index: 1, kind: "mutation", baseline_passed: true, candidate_passed: false },
    ];
    expect(summarizePairs(pairs)).toMatchObject({
      pairs: 4,
      baseline_passes: 2,
      candidate_passes: 3,
      baseline_only: 1,
      candidate_only: 2,
      lift: 0.25,
      mcnemar_exact_p: 1,
    });
    expect(pairedLiftConfidenceInterval(pairs, 2_000, 7)).toEqual(
      pairedLiftConfidenceInterval(pairs, 2_000, 7),
    );
  });
});
