import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { caseById } from "./verification-campaign";
import {
  discoverSubmittedTests,
  gradeWorkspace,
  gradeResultFromProcess,
  prepareGradeWorkspace,
  readRegularFileNoFollow,
  seedFixture,
  snapshotWorkspace,
} from "./verification-grader";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "fx-verification-grader-test-"));
  roots.push(root);
  return root;
}

function overwrite(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe("safe source copying", () => {
  test("reads a bounded regular file", () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, "value.ts"), "export const value = 1;\n");
    expect(readRegularFileNoFollow(root, "value.ts").toString()).toBe(
      "export const value = 1;\n",
    );
    expect(() => readRegularFileNoFollow(root, "../value.ts")).toThrow(
      "unsafe relative path",
    );
  });

  test("rejects final and parent symbolic links", () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    writeFileSync(join(outside, "secret.ts"), "secret\n");
    symlinkSync(join(outside, "secret.ts"), join(root, "direct.ts"));
    symlinkSync(outside, join(root, "linked"));

    expect(() => readRegularFileNoFollow(root, "direct.ts")).toThrow(
      "not a regular file",
    );
    expect(() => readRegularFileNoFollow(root, "linked/secret.ts")).toThrow(
      "non-directory component",
    );
  });
});

describe("grade workspace preparation", () => {
  test("copies only agent implementation over canonical visible tests", () => {
    const root = temporaryDirectory();
    const source = join(root, "source");
    const target = join(root, "target");
    const testCase = caseById("falsy-flags-roundtrip");
    seedFixture(testCase, source);
    overwrite(source, "flags-codec.ts", testCase.correct_files["flags-codec.ts"]!);
    overwrite(source, "flags-codec.test.ts", "test(\"weakened\", () => {});\n");

    const prepared = prepareGradeWorkspace(testCase, "visible", source, target);

    expect(prepared.test_files).toEqual(["flags-codec.test.ts"]);
    expect(readFileSync(join(target, "flags-codec.ts"), "utf8")).toBe(
      testCase.correct_files["flags-codec.ts"],
    );
    expect(readFileSync(join(target, "flags-codec.test.ts"), "utf8")).toBe(
      testCase.initial_files["flags-codec.test.ts"],
    );
  });

  test("submitted tests run against reference implementation in isolation", async () => {
    const root = temporaryDirectory();
    const source = join(root, "source");
    const target = join(root, "target");
    const testCase = caseById("falsy-flags-roundtrip");
    seedFixture(testCase, source);
    overwrite(
      source,
      "agent-regression.test.ts",
      `import { expect, test } from "bun:test";\nimport { decodeFlags, encodeFlags } from "./flags-codec";\ntest("falsy", () => { const value = { retries: 0, verbose: false, label: "" }; expect(decodeFlags(encodeFlags(value))).toEqual(value); });\n`,
    );

    expect(discoverSubmittedTests(testCase, source)).toEqual([
      "agent-regression.test.ts",
    ]);
    const result = await gradeWorkspace(
      testCase,
      "submitted",
      source,
      target,
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe("passed");
    expect(result.test_files).toEqual(["agent-regression.test.ts"]);
    expect(readFileSync(join(target, "flags-codec.ts"), "utf8")).toBe(
      testCase.correct_files["flags-codec.ts"],
    );
  });

  test("unchanged canonical tests are not claimed as submitted coverage", async () => {
    const root = temporaryDirectory();
    const source = join(root, "source");
    const target = join(root, "target");
    const testCase = caseById("pilot-temp-cleanup");
    seedFixture(testCase, source);

    const result = await gradeWorkspace(testCase, "submitted", source, target);

    expect(result.status).toBe("no-tests");
    expect(result.test_files).toEqual([]);
  });

  test("held-out grader distinguishes flawed and reference implementations", async () => {
    const root = temporaryDirectory();
    const testCase = caseById("pilot-temp-cleanup");
    const flawed = join(root, "flawed");
    const correct = join(root, "correct");
    seedFixture(testCase, flawed);
    seedFixture(testCase, correct, "correct");

    const flawedResult = await gradeWorkspace(
      testCase,
      "held-out",
      flawed,
      join(root, "flawed-grade"),
    );
    const correctResult = await gradeWorkspace(
      testCase,
      "held-out",
      correct,
      join(root, "correct-grade"),
    );

    expect(flawedResult.status).toBe("failed");
    expect(correctResult.status, `${correctResult.stdout}\n${correctResult.stderr}`).toBe(
      "passed",
    );
  });

  test("exit zero without a completed Bun test summary is invalid", async () => {
    const root = temporaryDirectory();
    const source = join(root, "source");
    const target = join(root, "target");
    const testCase = caseById("pilot-temp-cleanup");
    seedFixture(testCase, source);
    overwrite(
      source,
      "with-temp.ts",
      "process.exit(0);\nexport async function withTemp<T>(_path: string, _run: () => Promise<T>): Promise<T> { throw new Error(\"unreachable\"); }\n",
    );

    const result = await gradeWorkspace(
      testCase,
      "held-out",
      source,
      target,
    );

    expect(result.exit_code).toBe(0);
    expect(result.status).toBe("invalid");
    expect(result.test_summary).toBeNull();
    expect(result.error).toBe("grader emitted no complete Bun test summary");
  });

  test("grade result rejects synthetic exit-zero output without JUnit completion", () => {
    const result = gradeResultFromProcess({
      suite: "held-out",
      test_files: ["held-out.test.ts"],
      copied_implementation_files: [],
      copied_submitted_tests: [],
    }, {
      exit_code: 0,
      signal: null,
      timed_out: false,
      stdout: "",
      stderr: "",
    });
    expect(result.status).toBe("invalid");
  });
});

describe("workspace snapshots", () => {
  test("copies regular files and records content hashes", () => {
    const root = temporaryDirectory();
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(join(source, ".fx"), { recursive: true });
    writeFileSync(join(source, ".fx", "ignored"), "state");
    writeFileSync(join(source, "one.ts"), "one\n");

    const manifest = snapshotWorkspace(source, target);

    expect(manifest.files.map((file) => file.path)).toEqual(["one.ts"]);
    expect(readFileSync(join(target, "one.ts"), "utf8")).toBe("one\n");
    expect(JSON.parse(readFileSync(join(target, "snapshot-manifest.json"), "utf8")))
      .toEqual(manifest);
  });

  test("fails closed instead of following workspace links", () => {
    const root = temporaryDirectory();
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(source);
    symlinkSync("/etc/passwd", join(source, "linked"));

    expect(() => snapshotWorkspace(source, target)).toThrow(
      "workspace contains a symbolic link",
    );
  });
});
