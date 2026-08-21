import { spawn as nodeSpawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { compareStrings } from "./verification-common";
import {
  MAX_FIXTURE_FILE_BYTES,
  MAX_FIXTURE_TOTAL_BYTES,
  canonicalJson,
  caseById,
  sha256Text,
  type VerificationCase,
} from "./verification-campaign";

export const MAX_SNAPSHOT_FILES = 256;
export const MAX_SNAPSHOT_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_GRADE_OUTPUT_BYTES = 512 * 1024;
const IGNORED_DIRECTORIES = new Set([".fx", ".git", "node_modules"]);

export type GradeSuite = "visible" | "held-out" | "submitted";

export interface CopiedFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface SnapshotManifest {
  schema_version: 1;
  files: CopiedFile[];
  total_bytes: number;
}

export interface PreparedGrade {
  suite: GradeSuite;
  test_files: string[];
  copied_implementation_files: CopiedFile[];
  copied_submitted_tests: CopiedFile[];
}

export interface BunTestSummary {
  tests: number;
  assertions: number;
  failures: number;
  skipped: number;
  completed: number;
}

export interface GradeProcessResult {
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
}

export interface GradeResult extends PreparedGrade {
  status: "passed" | "failed" | "no-tests" | "invalid";
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  test_summary: BunTestSummary | null;
  error?: string;
}

function assertSafeRelativePath(path: string): void {
  if (!path || path.includes("\0") || path.startsWith("/") || path.startsWith("\\")) {
    throw new Error(`unsafe relative path: ${JSON.stringify(path)}`);
  }
  const parts = path.split(/[\\/]/);
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe relative path: ${JSON.stringify(path)}`);
  }
}

function pathInside(root: string, relativePath: string): string {
  assertSafeRelativePath(relativePath);
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, relativePath);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`path escapes root: ${relativePath}`);
  }
  return target;
}

function assertNoSymlinkComponents(root: string, relativePath: string): void {
  const resolvedRoot = resolve(root);
  const rootStat = lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`source root is not a plain directory: ${root}`);
  }
  const parts = relativePath.split(/[\\/]/);
  let current = resolvedRoot;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`source path contains a non-directory component: ${relativePath}`);
    }
  }
}

function ensureEmptyDirectory(path: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`target is not a plain directory: ${path}`);
    }
    if (readdirSync(path).length !== 0) {
      throw new Error(`target directory is not empty: ${path}`);
    }
  } else {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}

export function readRegularFileNoFollow(
  root: string,
  relativePath: string,
  maxBytes = MAX_FIXTURE_FILE_BYTES,
): Buffer {
  const path = pathInside(root, relativePath);
  assertNoSymlinkComponents(root, relativePath);
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`source is not a regular file: ${relativePath}`);
  }
  if (before.size > maxBytes) {
    throw new Error(`source exceeds ${maxBytes} bytes: ${relativePath}`);
  }
  const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW;
  if (noFollow === undefined) throw new Error("O_NOFOLLOW is unavailable");
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size !== before.size || opened.ino !== before.ino) {
      throw new Error(`source changed while opening: ${relativePath}`);
    }
    const content = readFileSync(fd);
    if (content.byteLength > maxBytes) {
      throw new Error(`source exceeds ${maxBytes} bytes: ${relativePath}`);
    }
    return content;
  } finally {
    closeSync(fd);
  }
}

function writeCanonicalFile(root: string, relativePath: string, content: string): CopiedFile {
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_FIXTURE_FILE_BYTES) {
    throw new Error(`canonical file exceeds ${MAX_FIXTURE_FILE_BYTES} bytes: ${relativePath}`);
  }
  const target = pathInside(root, relativePath);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, content, { mode: 0o600, flag: "wx" });
  return { path: relativePath, bytes, sha256: sha256Text(content) };
}

function copyRegularFileNoFollow(
  sourceRoot: string,
  targetRoot: string,
  relativePath: string,
  maxBytes = MAX_FIXTURE_FILE_BYTES,
): CopiedFile {
  const content = readRegularFileNoFollow(sourceRoot, relativePath, maxBytes);
  const target = pathInside(targetRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, content, { mode: 0o600, flag: "wx" });
  return {
    path: relativePath,
    bytes: content.byteLength,
    sha256: sha256Text(content),
  };
}

function isTestPath(path: string): boolean {
  return /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function listRegularFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    const relativeDirectory = relative(root, directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`workspace contains a symbolic link: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`workspace contains a special file: ${relativePath}`);
      }
      files.push(relativePath);
      if (files.length > MAX_SNAPSHOT_FILES) {
        throw new Error(`workspace exceeds ${MAX_SNAPSHOT_FILES} files`);
      }
    }
  };
  visit(root);
  return files.sort();
}

function canonicalBaseFiles(testCase: VerificationCase): Record<string, string> {
  return Object.fromEntries(
    Object.entries(testCase.initial_files).filter(([path]) => !isTestPath(path)),
  );
}

export function seedFixture(
  testCase: VerificationCase,
  targetRoot: string,
  implementation: "flawed" | "correct" = "flawed",
): SnapshotManifest {
  ensureEmptyDirectory(targetRoot);
  const files = {
    ...testCase.initial_files,
    ...(implementation === "correct" ? testCase.correct_files : {}),
  };
  const copied = Object.entries(files)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([path, content]) => writeCanonicalFile(targetRoot, path, content));
  const total_bytes = copied.reduce((sum, file) => sum + file.bytes, 0);
  if (total_bytes > MAX_FIXTURE_TOTAL_BYTES) {
    throw new Error(`fixture exceeds ${MAX_FIXTURE_TOTAL_BYTES} bytes`);
  }
  return { schema_version: 1, files: copied, total_bytes };
}

export function discoverSubmittedTests(
  testCase: VerificationCase,
  sourceRoot: string,
): string[] {
  return listRegularFiles(sourceRoot).filter((path) => {
    if (!isTestPath(path)) return false;
    const canonical = testCase.initial_files[path];
    if (canonical === undefined) return true;
    const content = readRegularFileNoFollow(sourceRoot, path);
    return sha256Text(content) !== sha256Text(canonical);
  });
}

export function prepareGradeWorkspace(
  testCase: VerificationCase,
  suite: GradeSuite,
  sourceRoot: string,
  targetRoot: string,
): PreparedGrade {
  ensureEmptyDirectory(targetRoot);
  const baseFiles = suite === "submitted"
    ? { ...canonicalBaseFiles(testCase), ...testCase.correct_files }
    : canonicalBaseFiles(testCase);
  for (
    const [path, content] of Object.entries(baseFiles).sort(
      ([left], [right]) => compareStrings(left, right),
    )
  ) {
    writeCanonicalFile(targetRoot, path, content);
  }

  const copied_implementation_files: CopiedFile[] = [];
  if (suite !== "submitted") {
    for (const path of testCase.implementation_files) {
      const existing = pathInside(targetRoot, path);
      rmSync(existing, { force: true });
      copied_implementation_files.push(
        copyRegularFileNoFollow(sourceRoot, targetRoot, path),
      );
    }
  }

  const copied_submitted_tests: CopiedFile[] = [];
  let test_files: string[];
  if (suite === "visible") {
    for (const path of testCase.visible_test_files) {
      const content = testCase.initial_files[path];
      if (content === undefined) throw new Error(`missing canonical visible test: ${path}`);
      writeCanonicalFile(targetRoot, path, content);
    }
    test_files = [...testCase.visible_test_files];
  } else if (suite === "held-out") {
    for (const [path, content] of Object.entries(testCase.held_out_files)) {
      writeCanonicalFile(targetRoot, path, content);
    }
    test_files = Object.keys(testCase.held_out_files).sort();
  } else {
    const submitted = discoverSubmittedTests(testCase, sourceRoot);
    for (const path of submitted) {
      copied_submitted_tests.push(
        copyRegularFileNoFollow(sourceRoot, targetRoot, path),
      );
    }
    test_files = submitted;
  }

  return {
    suite,
    test_files,
    copied_implementation_files,
    copied_submitted_tests,
  };
}

export function snapshotWorkspace(sourceRoot: string, targetRoot: string): SnapshotManifest {
  ensureEmptyDirectory(targetRoot);
  const copied: CopiedFile[] = [];
  let total_bytes = 0;
  for (const path of listRegularFiles(sourceRoot)) {
    const file = copyRegularFileNoFollow(
      sourceRoot,
      targetRoot,
      path,
      MAX_SNAPSHOT_TOTAL_BYTES,
    );
    total_bytes += file.bytes;
    if (total_bytes > MAX_SNAPSHOT_TOTAL_BYTES) {
      throw new Error(`workspace exceeds ${MAX_SNAPSHOT_TOTAL_BYTES} bytes`);
    }
    copied.push(file);
  }
  const manifest: SnapshotManifest = { schema_version: 1, files: copied, total_bytes };
  writeFileSync(
    join(targetRoot, "snapshot-manifest.json"),
    canonicalJson(manifest),
    { mode: 0o600, flag: "wx" },
  );
  return manifest;
}

function integerAttribute(attributes: string, name: string): number | null {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}="([0-9]+)"(?:\\s|$)`));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

export function parseBunTestSummary(stdout: string): BunTestSummary | null {
  const reports = [...stdout.matchAll(
    /<\?xml version="1\.0" encoding="UTF-8"\?>\s*<testsuites\b([^>]*)>[\s\S]*?<\/testsuites>/g,
  )];
  if (reports.length !== 1) return null;
  const attributes = reports[0]![1]!;
  const tests = integerAttribute(attributes, "tests");
  const assertions = integerAttribute(attributes, "assertions");
  const failures = integerAttribute(attributes, "failures");
  const skipped = integerAttribute(attributes, "skipped");
  if (
    tests === null ||
    assertions === null ||
    failures === null ||
    skipped === null ||
    skipped > tests ||
    failures > tests
  ) return null;
  return {
    tests,
    assertions,
    failures,
    skipped,
    completed: tests - skipped,
  };
}

export function gradeResultFromProcess(
  prepared: PreparedGrade,
  processResult: GradeProcessResult,
): GradeResult {
  if (prepared.test_files.length === 0) {
    return {
      ...prepared,
      ...processResult,
      status: "no-tests",
      test_summary: null,
    };
  }
  const summary = parseBunTestSummary(processResult.stdout);
  if (!summary || summary.completed === 0) {
    return {
      ...prepared,
      ...processResult,
      status: "invalid",
      test_summary: summary,
      error: summary
        ? "grader reported no completed tests"
        : "grader emitted no complete Bun test summary",
    };
  }
  return {
    ...prepared,
    ...processResult,
    status: processResult.exit_code === 0 &&
        !processResult.timed_out &&
        summary.failures === 0
      ? "passed"
      : "failed",
    test_summary: summary,
  };
}

async function runTests(
  root: string,
  testFiles: readonly string[],
  timeoutMs: number,
): Promise<GradeProcessResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = nodeSpawn("bun", [
      "test",
      ...testFiles,
      "--reporter=junit",
      "--reporter-outfile",
      "/dev/stdout",
    ], {
      cwd: root,
      env: {
        HOME: process.env.HOME ?? "/tmp",
        NO_COLOR: "1",
        PATH: process.env.PATH ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    const append = (target: Buffer[], value: Buffer): void => {
      outputBytes += value.byteLength;
      if (outputBytes > MAX_GRADE_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(value);
    };
    child.stdout.on("data", (value: Buffer) => append(stdout, value));
    child.stderr.on("data", (value: Buffer) => append(stderr, value));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exit_code: code,
        signal,
        timed_out: timedOut,
        stdout: Buffer.concat(stdout).toString(),
        stderr: `${Buffer.concat(stderr).toString()}${
          outputExceeded ? "grader output exceeded limit\n" : ""
        }`,
      });
    });
  });
}

export async function gradeWorkspace(
  testCase: VerificationCase,
  suite: GradeSuite,
  sourceRoot: string,
  targetRoot: string,
  timeoutMs = 30_000,
): Promise<GradeResult> {
  try {
    const prepared = prepareGradeWorkspace(testCase, suite, sourceRoot, targetRoot);
    if (prepared.test_files.length === 0) {
      return gradeResultFromProcess(prepared, {
        exit_code: null,
        signal: null,
        timed_out: false,
        stdout: "",
        stderr: "",
      });
    }
    return gradeResultFromProcess(
      prepared,
      await runTests(targetRoot, prepared.test_files, timeoutMs),
    );
  } catch (error) {
    return {
      suite,
      test_files: [],
      copied_implementation_files: [],
      copied_submitted_tests: [],
      status: "invalid",
      exit_code: null,
      signal: null,
      timed_out: false,
      stdout: "",
      stderr: "",
      test_summary: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const testCase = caseById(argument("--case"));
  if (command === "seed") {
    const manifest = seedFixture(
      testCase,
      argument("--target"),
      process.argv.includes("--correct") ? "correct" : "flawed",
    );
    process.stdout.write(canonicalJson(manifest));
    return;
  }
  if (command === "snapshot") {
    const manifest = snapshotWorkspace(argument("--source"), argument("--target"));
    process.stdout.write(canonicalJson(manifest));
    return;
  }
  if (command === "prepare") {
    const suite = argument("--suite") as GradeSuite;
    if (!(["visible", "held-out", "submitted"] as string[]).includes(suite)) {
      throw new Error(`invalid --suite: ${suite}`);
    }
    const prepared = prepareGradeWorkspace(
      testCase,
      suite,
      argument("--source"),
      argument("--target"),
    );
    process.stdout.write(canonicalJson(prepared));
    return;
  }
  throw new Error(`usage: verification-grader.ts <seed|snapshot|prepare> --case ID ...`);
}

if (import.meta.main) {
  await main();
}
