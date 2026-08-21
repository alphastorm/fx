import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { userInfo } from "node:os";
import {
  requireAbsoluteExecutableBinary,
  sha256File,
  type AbSide,
} from "./agent-quality-ab";
import {
  FINAL_TRIALS_PER_CASE,
  buildFrozenManifest,
  canonicalJson,
  caseById,
  casesForPhase,
  promptForArm,
  sha256Text,
  summarizePairs,
  validateFrozenManifest,
  type CampaignPhase,
  type FrozenBinary,
  type FrozenCampaignManifest,
  type PairedOutcome,
  type PilotArm,
  type VerificationCase,
} from "./verification-campaign";
import type { GradeResult, SnapshotManifest } from "./verification-grader";
import {
  CHAT_PATH,
  CATALOG_PATH,
  PROXY_IDLE_TIMEOUT_SECONDS,
  pinnedCatalogJson,
  startHostGatewayProxy,
  validGatewayTeam,
  type ProxyEvent,
} from "./verification-gateway-proxy";
import { HAS_API_KEY, type HeadlessResult } from "./eval-helpers";

const EVAL_DIRECTORY = import.meta.dirname;
const CONTAINER_ENTRY = join(EVAL_DIRECTORY, "verification-container.ts");
const PROXY_ENTRY = join(EVAL_DIRECTORY, "verification-gateway-proxy.ts");
const COMMON_ENTRY = join(EVAL_DIRECTORY, "verification-common.ts");
const GRADER_ENTRY = join(EVAL_DIRECTORY, "verification-grader.ts");
const DEFAULT_UPSTREAM = "https://ai-gateway.vercel.sh/v3/ai/language-model";
const MAX_PROCESS_OUTPUT_BYTES = 32 * 1024 * 1024;
const MUTATION_TOOL_NAMES = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "rename_file",
  "copy_file",
  "create_folder",
]);

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  duration_ms: number;
}

export interface PreflightBinaryResult {
  label: "baseline" | "candidate";
  path: string;
  sha256: string;
  version: string;
  process: ProcessResult;
  shell: string | null;
  valid: boolean;
  reasons: string[];
  artifact_directory: string;
}

export interface PreflightReceipt {
  schema_version: 1;
  created_at: string;
  image: { reference: string; digest: string; user_probe: string };
  model: string;
  catalog_sha256: string;
  binaries: PreflightBinaryResult[];
  valid: boolean;
  receipt_sha256: string;
}

export interface CoordinateIdentity {
  case_id: string;
  trial_index: number;
  order_index: number;
  arm: AbSide | PilotArm;
}

export interface CoordinateValidity {
  valid: boolean;
  reasons: string[];
  mutated_with_builtin: boolean;
  reminder_count: number;
  treatment_exposed: boolean;
  verification_commands: string[];
  truthful_report: boolean;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache_read: number;
    cache_write: number;
  };
}

export interface CoordinateResult {
  schema_version: 1;
  manifest_sha256: string;
  coordinate: CoordinateIdentity;
  attempt: number;
  started_at: string;
  finished_at: string;
  binary_sha256: string;
  raw_artifact_directory: string;
  process: ProcessResult;
  validity: CoordinateValidity;
  headless: HeadlessResult | null;
  grades: {
    visible: GradeResult | null;
    held_out: GradeResult | null;
    submitted: GradeResult | null;
  };
  workspace_unchanged: boolean | null;
  output_contract_passed: boolean | null;
  passed: boolean;
  infrastructure_retryable: boolean;
}
interface HostGatewayCredential {
  token: string;
  gateway_team?: string;
}


interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout_ms?: number;
  max_output_bytes?: number;
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<ProcessResult> {
  const started = Date.now();
  return await new Promise((resolvePromise, reject) => {
    const child = nodeSpawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxBytes = options.max_output_bytes ?? MAX_PROCESS_OUTPUT_BYTES;
    let bytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    const append = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    const timer = options.timeout_ms
      ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeout_ms)
      : undefined;
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const limitMessage = outputExceeded ? "process output exceeded limit\n" : "";
      resolvePromise({
        stdout: Buffer.concat(stdout).toString(),
        stderr: `${Buffer.concat(stderr).toString()}${limitMessage}`,
        code,
        signal,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
      });
    });
  });
}

function requireSuccess(result: ProcessResult, description: string): ProcessResult {
  if (result.code !== 0 || result.timed_out) {
    throw new Error(
      `${description} failed (${result.code ?? result.signal ?? "unknown"})\n${result.stderr}${result.stdout}`,
    );
  }
  return result;
}
function decodedKeychainPayload(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return trimmed;
  if (trimmed.length === 0 || trimmed.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(trimmed)) {
    throw new Error("fx login Keychain item has an unsupported encoding");
  }
  return Buffer.from(trimmed, "hex").toString("utf8");
}

export function parseFxLoginCredential(
  raw: string,
  nowMs = Date.now(),
): HostGatewayCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodedKeychainPayload(raw));
  } catch (error) {
    if (error instanceof Error && error.message.includes("Keychain item")) throw error;
    throw new Error("fx login Keychain item is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("fx login Keychain item is not an object");
  }
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1 || value.issuer !== "https://vercel.com") {
    throw new Error("fx login Keychain item has unsupported metadata");
  }
  const expiresAt = value.expires_at_ms;
  if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) <= nowMs + 60_000) {
    throw new Error("fx login session is expired or too close to expiry");
  }
  const token = value.access_token;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 64 * 1024 ||
    token.trim() !== token
  ) {
    throw new Error("fx login session has an invalid access token");
  }
  const team = typeof value.team_id === "string"
    ? value.team_id
    : typeof value.team_slug === "string"
    ? value.team_slug
    : "";
  if (!validGatewayTeam(team)) {
    throw new Error("fx login session has no valid Gateway team");
  }
  return { token, gateway_team: team };
}

async function resolveHostGatewayCredential(): Promise<HostGatewayCredential> {
  const ambient = HAS_API_KEY
    ? process.env.VERCEL_OIDC_TOKEN ?? process.env.AI_GATEWAY_API_KEY
    : undefined;
  if (ambient?.trim()) {
    const team = process.env.FX_VERIFICATION_GATEWAY_TEAM;
    if (team && !validGatewayTeam(team)) {
      throw new Error("FX_VERIFICATION_GATEWAY_TEAM is invalid");
    }
    return { token: ambient, gateway_team: team || undefined };
  }
  if (process.platform !== "darwin") {
    throw new Error("host Gateway credential is unavailable");
  }
  const account = userInfo().username;
  const result = await runProcess(
    "/usr/bin/security",
    ["find-generic-password", "-a", account, "-s", "FX_OAUTH_SESSION_V1", "-w"],
    { timeout_ms: 10_000, max_output_bytes: 64 * 1024 },
  );
  if (result.code !== 0 || result.timed_out) {
    throw new Error("host Gateway credential is unavailable from fx login");
  }
  return parseFxLoginCredential(result.stdout);
}


async function docker(
  args: readonly string[],
  timeoutMs = 120_000,
): Promise<ProcessResult> {
  return await runProcess("docker", args, { timeout_ms: timeoutMs });
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function requirePinnedImageReference(reference: string): string {
  if (!/@sha256:[a-f0-9]{64}$/.test(reference)) {
    throw new Error("--image must be pinned by an immutable sha256 digest");
  }
  return reference;
}

function imageDigestFromReference(reference: string): string {
  return reference.slice(reference.lastIndexOf("@") + 1);
}

async function inspectImageDigest(reference: string): Promise<string> {
  requirePinnedImageReference(reference);
  const result = requireSuccess(
    await docker(["image", "inspect", reference, "--format", "{{.Id}}"]),
    "docker image inspect",
  );
  const digest = result.stdout.trim();
  if (digest !== imageDigestFromReference(reference)) {
    throw new Error(`image digest mismatch: reference ${imageDigestFromReference(reference)}, local ${digest}`);
  }
  return digest;
}

function requiredFlag(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}

function optionalFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function requiredAbsolutePath(args: readonly string[], name: string): string {
  const value = requiredFlag(args, name);
  if (!isAbsolute(value)) throw new Error(`${name} must be absolute: ${value}`);
  return resolve(value);
}

function executableBinary(args: readonly string[], name: string, label: string): string {
  return requireAbsoluteExecutableBinary(requiredAbsolutePath(args, name), label);
}

function resourceName(prefix: string, identity: string): string {
  return `fxv-${prefix}-${sha256Text(identity).slice(0, 16)}`;
}

class DockerResources {
  readonly volumes: string[] = [];
  readonly networks: string[] = [];
  readonly containers: string[] = [];

  constructor(readonly image: string) {}

  async createVolume(name: string): Promise<void> {
    requireSuccess(await docker(["volume", "create", name]), `create volume ${name}`);
    this.volumes.push(name);
    requireSuccess(await docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "0:0",
      "-v",
      `${name}:/volume`,
      this.image,
      "/bin/sh",
      "-c",
      "chown 1000:1000 /volume && chmod 700 /volume",
    ]), `initialize volume ${name}`);
  }

  async createNetwork(name: string, internal: boolean): Promise<void> {
    const args = ["network", "create"];
    if (internal) args.push("--internal");
    args.push(name);
    requireSuccess(await docker(args), `create network ${name}`);
    this.networks.push(name);
  }

  rememberContainer(name: string): void {
    this.containers.push(name);
  }

  async cleanup(): Promise<void> {
    for (const container of this.containers.reverse()) {
      await docker(["rm", "--force", container], 30_000).catch(() => undefined);
    }
    for (const network of this.networks.reverse()) {
      await docker(["network", "rm", network], 30_000).catch(() => undefined);
    }
    for (const volume of this.volumes.reverse()) {
      await docker(["volume", "rm", "--force", volume], 30_000).catch(() => undefined);
    }
  }
}

function trustedHarnessMounts(): string[] {
  return ["-v", `${EVAL_DIRECTORY}:/trusted:ro`];
}

function isolatedHarnessMounts(): string[] {
  return [
    "-v",
    `${CONTAINER_ENTRY}:/harness/verification-container.ts:ro`,
    "-v",
    `${PROXY_ENTRY}:/harness/verification-gateway-proxy.ts:ro`,
    "-v",
    `${COMMON_ENTRY}:/harness/verification-common.ts:ro`,
  ];
}

function hardenedContainerArgs(network: string): string[] {
  return [
    "--network",
    network,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m",
    "--user",
    "1000:1000",
  ];
}

async function snapshotNamedVolume(
  resources: DockerResources,
  sourceVolume: string,
  snapshotVolume: string,
  testCaseId: string,
): Promise<void> {
  await resources.createVolume(snapshotVolume);
  requireSuccess(await docker([
    "run",
    "--rm",
    ...hardenedContainerArgs("none"),
    ...trustedHarnessMounts(),
    "-v",
    `${sourceVolume}:/source:ro`,
    "-v",
    `${snapshotVolume}:/target`,
    resources.image,
    "bun",
    "/trusted/verification-grader.ts",
    "snapshot",
    "--case",
    testCaseId,
    "--source",
    "/source",
    "--target",
    "/target",
  ], 120_000), `snapshot volume ${sourceVolume}`);
}

async function exportTrustedVolume(
  resources: DockerResources,
  volume: string,
  targetDirectory: string,
  identity: string,
): Promise<void> {
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  const container = resourceName("export", identity);
  requireSuccess(await docker([
    "create",
    "--name",
    container,
    "--network",
    "none",
    "-v",
    `${volume}:/export:ro`,
    resources.image,
    "/bin/true",
  ]), `create exporter ${container}`);
  resources.rememberContainer(container);
  requireSuccess(await docker([
    "cp",
    `${container}:/export/.`,
    targetDirectory,
  ]), `export volume ${volume}`);
}

async function seedWorkspace(
  resources: DockerResources,
  volume: string,
  testCase: VerificationCase,
): Promise<SnapshotManifest> {
  const result = requireSuccess(await docker([
    "run",
    "--rm",
    ...hardenedContainerArgs("none"),
    ...trustedHarnessMounts(),
    "-v",
    `${volume}:/workspace`,
    resources.image,
    "bun",
    "/trusted/verification-grader.ts",
    "seed",
    "--case",
    testCase.id,
    "--target",
    "/workspace",
  ]), `seed ${testCase.id}`);
  return JSON.parse(result.stdout) as SnapshotManifest;
}

async function gradeNamedVolume(
  resources: DockerResources,
  sourceVolume: string,
  gradeVolume: string,
  testCase: VerificationCase,
  suite: "visible" | "held-out" | "submitted",
  artifactDirectory: string,
): Promise<GradeResult> {
  await resources.createVolume(gradeVolume);
  const raw = await docker([
    "run",
    "--rm",
    ...hardenedContainerArgs("none"),
    ...trustedHarnessMounts(),
    "-v",
    `${sourceVolume}:/source:ro`,
    "-v",
    `${gradeVolume}:/target`,
    resources.image,
    "bun",
    GRADER_ENTRY.replace(EVAL_DIRECTORY, "/trusted"),
    "grade",
    "--case",
    testCase.id,
    "--suite",
    suite,
    "--source",
    "/source",
    "--target",
    "/target",
  ], 120_000);
  mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  writeAtomic(join(artifactDirectory, "stdout.json"), raw.stdout);
  writeAtomic(join(artifactDirectory, "stderr.txt"), raw.stderr);
  writeAtomic(join(artifactDirectory, "process.json"), canonicalJson(raw));
  const snapshotVolume = `${gradeVolume}-snapshot`;
  await snapshotNamedVolume(resources, gradeVolume, snapshotVolume, testCase.id);
  await exportTrustedVolume(
    resources,
    snapshotVolume,
    join(artifactDirectory, "workspace"),
    `${gradeVolume}-workspace`,
  );
  if (raw.code !== 0 && !raw.stdout.trim()) {
    return {
      suite,
      test_files: [],
      copied_implementation_files: [],
      copied_submitted_tests: [],
      status: "invalid",
      exit_code: raw.code,
      signal: raw.signal,
      timed_out: raw.timed_out,
      stdout: "",
      stderr: raw.stderr,
      error: "grader process failed without JSON output",
    };
  }
  try {
    return JSON.parse(raw.stdout) as GradeResult;
  } catch {
    return {
      suite,
      test_files: [],
      copied_implementation_files: [],
      copied_submitted_tests: [],
      status: "invalid",
      exit_code: raw.code,
      signal: raw.signal,
      timed_out: raw.timed_out,
      stdout: raw.stdout,
      stderr: raw.stderr,
      error: "grader emitted malformed JSON",
    };
  }
}

export interface AgentDockerArgsInput {
  image: string;
  network: string;
  workspace_volume: string;
  home_volume: string;
  evidence_volume: string;
  binary_path: string;
  model: string;
  prompt: string;
  nonce: string;
  timeout_ms: number;
  agent_steps: number;
}

export function buildAgentDockerArgs(input: AgentDockerArgsInput): string[] {
  return [
    "run",
    "--rm",
    ...hardenedContainerArgs(input.network),
    ...isolatedHarnessMounts(),
    "-v",
    `${input.workspace_volume}:/workspace`,
    "-v",
    `${input.home_volume}:/home/bun`,
    "-v",
    `${input.evidence_volume}:/evidence`,
    "-v",
    `${input.binary_path}:/opt/fx/fx:ro`,
    "-w",
    "/workspace",
    "-e",
    "HOME=/home/bun",
    "-e",
    "SHELL=/bin/sh",
    "-e",
    `FX_MODEL=${input.model}`,
    "-e",
    `FX_VERIFICATION_NONCE=${input.nonce}`,
    "-e",
    "FX_VERIFICATION_RELAY_URL=http://relay:8787",
    "-e",
    `FX_VERIFICATION_PROMPT=${input.prompt}`,
    "-e",
    `FX_VERIFICATION_TIMEOUT_MS=${input.timeout_ms}`,
    "-e",
    `FX_VERIFICATION_AGENT_STEPS=${input.agent_steps}`,
    input.image,
    "bun",
    "/harness/verification-container.ts",
    "coordinate",
  ];
}

export interface RelayDockerArgsInput {
  image: string;
  container: string;
  internal_network: string;
  evidence_volume: string;
  nonce: string;
  host_proxy_url: string;
  model: string;
}

export function buildRelayDockerArgs(input: RelayDockerArgsInput): string[] {
  return [
    "run",
    "--detach",
    "--name",
    input.container,
    "--network",
    input.internal_network,
    "--network-alias",
    "relay",
    "--add-host",
    "host.docker.internal:host-gateway",
    ...hardenedContainerArgs(input.internal_network).slice(2),
    "-v",
    `${PROXY_ENTRY}:/harness/verification-gateway-proxy.ts:ro`,
    "-v",
    `${COMMON_ENTRY}:/harness/verification-common.ts:ro`,
    "-v",
    `${input.evidence_volume}:/evidence`,
    "-e",
    `FX_VERIFICATION_NONCE=${input.nonce}`,
    "-e",
    `FX_VERIFICATION_HOST_PROXY_URL=${input.host_proxy_url}`,
    "-e",
    `FX_MODEL=${input.model}`,
    "-e",
    "FX_VERIFICATION_PROXY_LOG=/evidence/relay-proxy.jsonl",
    input.image,
    "bun",
    "/harness/verification-gateway-proxy.ts",
    "relay",
  ];
}

async function waitForRelay(container: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const logs = await docker(["logs", container], 10_000);
    if (`${logs.stdout}\n${logs.stderr}`.includes("verification-proxy-ready relay")) return;
    const state = await docker(["inspect", container, "--format", "{{.State.Running}}"]);
    if (state.stdout.trim() !== "true") {
      throw new Error(`relay exited before readiness\n${logs.stdout}${logs.stderr}`);
    }
    await Bun.sleep(100);
  }
  throw new Error("relay readiness timeout");
}

function binaryForArm(manifest: FrozenCampaignManifest, arm: AbSide | PilotArm): FrozenBinary {
  return arm === "candidate" ? manifest.binaries.candidate : manifest.binaries.baseline;
}

function parseJsonLines(path: string): ProxyEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProxyEvent);
}

function reminderCount(trace: string): number {
  return trace.match(/final_verification_injected/g)?.length ?? 0;
}

function successfulBuiltinMutation(headless: HeadlessResult | null): boolean {
  return headless?.tool_calls?.some(
    (call) => MUTATION_TOOL_NAMES.has(call.name) && call.status === "success",
  ) ?? false;
}

function verificationCommands(headless: HeadlessResult | null): string[] {
  return (headless?.tool_calls ?? [])
    .filter((call) => call.name === "terminal" || call.name === "run_command")
    .filter((call) => call.status === "success" && call.command_result?.exit_code === 0)
    .map((call) => call.command_result?.command ?? "")
    .filter((command) => /(?:^|\s)(?:bun\s+test|zig\s+(?:build|test)|tsc\b|npm\s+test|cargo\s+test|pytest\b)/.test(command));
}

function reportIsTruthful(headless: HeadlessResult | null, commands: readonly string[]): boolean {
  if (!headless) return false;
  const claimsVerification = /(?:tests?|build|typecheck|compiler).{0,40}(?:pass|succeed|clean|verified)/i
    .test(headless.output);
  return !claimsVerification || commands.length > 0;
}

function sumProxyUsage(events: readonly ProxyEvent[]): CoordinateValidity["tokens"] {
  const totals = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
  for (const event of events) {
    const usage = event.evidence?.usage;
    if (!usage) continue;
    totals.input += usage.input_tokens;
    totals.output += usage.output_tokens;
    totals.reasoning += usage.reasoning_tokens;
    totals.cache_read += usage.cache_read_tokens;
    totals.cache_write += usage.cache_write_tokens;
  }
  return totals;
}

export interface ValidityInput {
  coordinate: CoordinateIdentity;
  process: ProcessResult;
  headless: HeadlessResult | null;
  parse_error?: string;
  host_events: readonly ProxyEvent[];
  relay_events: readonly ProxyEvent[];
  local_events: readonly ProxyEvent[];
  trace: string;
}

export function classifyCoordinateValidity(input: ValidityInput): CoordinateValidity {
  const reasons: string[] = [];
  if (input.process.timed_out) reasons.push("docker_timed_out");
  if (input.process.code !== 0) reasons.push(`docker_exit_${input.process.code ?? "signal"}`);
  if (input.parse_error) reasons.push(`malformed_headless_json:${input.parse_error}`);
  if (!input.headless) reasons.push("headless_result_missing");
  if (input.headless?.exit_code !== 0) reasons.push("headless_exit_nonzero");
  if (input.headless?.error) reasons.push("headless_error");
  if (`${input.process.stdout}\n${input.process.stderr}\n${input.trace}`.includes("MissingLoginShell")) {
    reasons.push("missing_login_shell");
  }
  if (input.host_events.length === 0) reasons.push("host_proxy_no_requests");
  for (const event of input.host_events) {
    if (event.outcome !== "forwarded" || event.upstream_status === undefined || event.upstream_status < 200 || event.upstream_status >= 300) {
      reasons.push("host_proxy_request_failed");
      break;
    }
    if (!event.evidence?.finished || event.evidence.malformed_event_count !== 0) {
      reasons.push("gateway_stream_invalid");
      break;
    }
  }
  for (const [layer, events] of [["relay", input.relay_events], ["local", input.local_events]] as const) {
    if (events.length === 0) reasons.push(`${layer}_proxy_no_requests`);
    if (events.some((event) => event.outcome === "rejected" || event.outcome === "upstream-error")) {
      reasons.push(`${layer}_proxy_request_failed`);
    }
  }
  if (!input.relay_events.some((event) => event.outcome === "catalog" && event.path === CATALOG_PATH)) {
    reasons.push("pinned_catalog_not_observed");
  }
  const mutated = successfulBuiltinMutation(input.headless);
  const count = reminderCount(input.trace);
  const expectedReminder = input.coordinate.arm === "candidate" && mutated ? 1 : 0;
  if (count !== expectedReminder) reasons.push("reminder_count_mismatch");
  const commands = verificationCommands(input.headless);
  return {
    valid: reasons.length === 0,
    reasons: [...new Set(reasons)],
    mutated_with_builtin: mutated,
    reminder_count: count,
    treatment_exposed: expectedReminder === 1 && count === 1,
    verification_commands: commands,
    truthful_report: reportIsTruthful(input.headless, commands),
    tokens: sumProxyUsage(input.host_events),
  };
}

function retryableInfrastructure(reasons: readonly string[]): boolean {
  if (reasons.length === 0) return false;
  const retryable = new Set([
    "docker_timed_out",
    "host_proxy_no_requests",
    "host_proxy_request_failed",
    "gateway_stream_invalid",
    "relay_proxy_no_requests",
    "relay_proxy_request_failed",
    "local_proxy_no_requests",
    "local_proxy_request_failed",
    "pinned_catalog_not_observed",
    "missing_login_shell",
  ]);
  return reasons.every((reason) =>
    retryable.has(reason) || reason.startsWith("malformed_headless_json:"));
}

function snapshotEqual(left: SnapshotManifest, right: SnapshotManifest): boolean {
  const project = (manifest: SnapshotManifest) => manifest.files.map((file) => ({
    path: file.path,
    bytes: file.bytes,
    sha256: file.sha256,
  }));
  return canonicalJson(project(left)) === canonicalJson(project(right));
}

function outputContractPassed(testCase: VerificationCase, headless: HeadlessResult | null): boolean {
  if (!headless || !testCase.expected_output_fragments) return false;
  return testCase.expected_output_fragments.every((fragment) => headless.output.includes(fragment));
}

function coordinateDirectory(outputDirectory: string, coordinate: CoordinateIdentity): string {
  return join(
    outputDirectory,
    "coordinates",
    coordinate.case_id,
    `trial-${String(coordinate.trial_index).padStart(2, "0")}`,
    coordinate.arm,
  );
}

async function runCoordinateAttempt(input: {
  manifest: FrozenCampaignManifest;
  coordinate: CoordinateIdentity;
  attempt: number;
  output_directory: string;
  host_proxy: ReturnType<typeof startHostGatewayProxy>;
  allowed_nonces: Set<string>;
}): Promise<CoordinateResult> {
  const { manifest, coordinate, attempt, output_directory, host_proxy, allowed_nonces } = input;
  const testCase = caseById(coordinate.case_id);
  const binary = binaryForArm(manifest, coordinate.arm);
  const identity = `${manifest.manifest_sha256}:${coordinate.case_id}:${coordinate.trial_index}:${coordinate.arm}:${attempt}`;
  const attemptDirectory = join(coordinateDirectory(output_directory, coordinate), `attempt-${attempt}`);
  mkdirSync(attemptDirectory, { recursive: true, mode: 0o700 });
  const resources = new DockerResources(manifest.image.reference);
  const names = {
    workspace: resourceName("workspace", identity),
    home: resourceName("home", identity),
    agentEvidence: resourceName("agent-evidence", identity),
    relayEvidence: resourceName("relay-evidence", identity),
    internalNetwork: resourceName("internal", identity),
    edgeNetwork: resourceName("edge", identity),
    relay: resourceName("relay", identity),
  };
  const nonce = randomBytes(32).toString("base64url");
  const startedAt = new Date().toISOString();
  let rawProcess: ProcessResult = {
    stdout: "",
    stderr: "coordinate did not start\n",
    code: null,
    signal: null,
    timed_out: false,
    duration_ms: 0,
  };
  let seedManifest: SnapshotManifest = { schema_version: 1, files: [], total_bytes: 0 };
  let hostEvents: ProxyEvent[] = [];
  let workspaceSnapshot: SnapshotManifest | null = null;
  let persistenceFailure: string | null = null;
  const hostEventStart = host_proxy.events.length;
  try {
  try {
    for (const volume of [names.workspace, names.home, names.agentEvidence, names.relayEvidence]) {
      await resources.createVolume(volume);
    }
    seedManifest = await seedWorkspace(resources, names.workspace, testCase);
    writeAtomic(join(attemptDirectory, "seed-manifest.json"), canonicalJson(seedManifest));
    await resources.createNetwork(names.internalNetwork, true);
    await resources.createNetwork(names.edgeNetwork, false);
    allowed_nonces.add(nonce);
    const hostPort = new URL(host_proxy.url).port;
    const relayArgs = buildRelayDockerArgs({
      image: manifest.image.reference,
      container: names.relay,
      internal_network: names.internalNetwork,
      evidence_volume: names.relayEvidence,
      nonce,
      host_proxy_url: `http://host.docker.internal:${hostPort}`,
      model: manifest.gateway.model,
    });
    requireSuccess(await docker(relayArgs, 60_000), "start relay");
    resources.rememberContainer(names.relay);
    requireSuccess(await docker([
      "network",
      "connect",
      names.edgeNetwork,
      names.relay,
    ]), "connect relay edge network");
    await waitForRelay(names.relay);

    rawProcess = await docker(buildAgentDockerArgs({
      image: manifest.image.reference,
      network: names.internalNetwork,
      workspace_volume: names.workspace,
      home_volume: names.home,
      evidence_volume: names.agentEvidence,
      binary_path: binary.path,
      model: manifest.gateway.model,
      prompt: promptForArm(testCase, coordinate.arm),
      nonce,
      timeout_ms: manifest.execution.coordinate_timeout_ms,
      agent_steps: manifest.execution.agent_step_limit,
    }), manifest.execution.coordinate_timeout_ms + 60_000);
    hostEvents = host_proxy.events.slice(hostEventStart);

    writeAtomic(join(attemptDirectory, "fx-stdout.json"), rawProcess.stdout);
    writeAtomic(join(attemptDirectory, "fx-stderr.txt"), rawProcess.stderr);
    writeAtomic(join(attemptDirectory, "raw-process.json"), canonicalJson({
      schema_version: 1,
      manifest_sha256: manifest.manifest_sha256,
      coordinate,
      attempt,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      binary_sha256: binary.sha256,
      process: rawProcess,
      resource_names: names,
      nonce_sha256: sha256Text(nonce),
    }));
    writeAtomic(join(attemptDirectory, "host-proxy.json"), canonicalJson(hostEvents));

    for (const [source, label] of [
      [names.workspace, "workspace"],
      [names.agentEvidence, "agent-evidence"],
      [names.relayEvidence, "relay-evidence"],
    ] as const) {
      const snapshot = resourceName(`${label}-snapshot`, identity);
      await snapshotNamedVolume(resources, source, snapshot, testCase.id);
      await exportTrustedVolume(
        resources,
        snapshot,
        join(attemptDirectory, label),
        `${identity}:${label}`,
      );
      if (label === "workspace") {
        workspaceSnapshot = readJson<SnapshotManifest>(
          join(attemptDirectory, label, "snapshot-manifest.json"),
        );
      }
    }
  } catch (error) {
    persistenceFailure = error instanceof Error ? error.message : String(error);
    hostEvents = host_proxy.events.slice(hostEventStart);
    if (!existsSync(join(attemptDirectory, "fx-stdout.json"))) {
      writeAtomic(join(attemptDirectory, "fx-stdout.json"), rawProcess.stdout);
      writeAtomic(join(attemptDirectory, "fx-stderr.txt"), rawProcess.stderr);
      writeAtomic(join(attemptDirectory, "raw-process.json"), canonicalJson({
        schema_version: 1,
        manifest_sha256: manifest.manifest_sha256,
        coordinate,
        attempt,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        binary_sha256: binary.sha256,
        process: rawProcess,
        resource_names: names,
        nonce_sha256: sha256Text(nonce),
        persistence_failure: persistenceFailure,
      }));
      writeAtomic(join(attemptDirectory, "host-proxy.json"), canonicalJson(hostEvents));
    }
  }

  let headless: HeadlessResult | null = null;
  let parseError: string | undefined;
  try {
    headless = JSON.parse(rawProcess.stdout.trim()) as HeadlessResult;
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  const tracePath = join(attemptDirectory, "agent-evidence", "fx.trace");
  const localLogPath = join(attemptDirectory, "agent-evidence", "local-proxy.jsonl");
  const relayLogPath = join(attemptDirectory, "relay-evidence", "relay-proxy.jsonl");
  const trace = existsSync(tracePath) ? readFileSync(tracePath, "utf8") : "";
  let localEvents: ProxyEvent[] = [];
  let relayEvents: ProxyEvent[] = [];
  try {
    localEvents = parseJsonLines(localLogPath);
    relayEvents = parseJsonLines(relayLogPath);
  } catch (error) {
    parseError = `${parseError ?? ""}; proxy log parse: ${error instanceof Error ? error.message : String(error)}`;
  }
  const validity = classifyCoordinateValidity({
    coordinate,
    process: rawProcess,
    headless,
    parse_error: persistenceFailure ?? parseError,
    host_events: hostEvents,
    relay_events: relayEvents,
    local_events: localEvents,
    trace,
  });

  const grades: CoordinateResult["grades"] = { visible: null, held_out: null, submitted: null };
  if (workspaceSnapshot && testCase.kind === "mutation") {
    for (const suite of ["visible", "held-out", "submitted"] as const) {
      const gradeVolume = resourceName(`grade-${suite}`, identity);
      grades[suite === "held-out" ? "held_out" : suite] = await gradeNamedVolume(
        resources,
        names.workspace,
        gradeVolume,
        testCase,
        suite,
        join(attemptDirectory, "grades", suite),
      );
    }
  }
  const workspaceUnchanged = workspaceSnapshot && testCase.kind === "read-only"
    ? snapshotEqual(seedManifest, workspaceSnapshot)
    : null;
  const outputPassed = testCase.kind === "read-only"
    ? outputContractPassed(testCase, headless)
    : null;
  const passed = validity.valid && validity.truthful_report && (
    testCase.kind === "mutation"
      ? grades.visible?.status === "passed" && grades.held_out?.status === "passed"
      : workspaceUnchanged === true && outputPassed === true
  );
  const result: CoordinateResult = {
    schema_version: 1,
    manifest_sha256: manifest.manifest_sha256,
    coordinate,
    attempt,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    binary_sha256: binary.sha256,
    raw_artifact_directory: attemptDirectory,
    process: rawProcess,
    validity,
    headless,
    grades,
    workspace_unchanged: workspaceUnchanged,
    output_contract_passed: outputPassed,
    passed,
    infrastructure_retryable: !validity.valid && retryableInfrastructure(validity.reasons),
  };
  writeAtomic(join(attemptDirectory, "result.json"), canonicalJson(result));
    return result;
  } finally {
    allowed_nonces.delete(nonce);
    await resources.cleanup();
  }
}

async function runCampaign(
  manifest: FrozenCampaignManifest,
  outputDirectory: string,
  credential: HostGatewayCredential,
): Promise<void> {
  validateFrozenManifest(manifest);
  await verifyFrozenRuntime(manifest);
  const allowedNonces = new Set<string>();
  const hostProxy = startHostGatewayProxy({
    upstream_url: manifest.gateway.upstream,
    credential: credential.token,
    gateway_team: credential.gateway_team,
    model: manifest.gateway.model,
    allowed_nonces: allowedNonces,
    hostname: "0.0.0.0",
    port: 0,
    timeout_ms: Math.min(manifest.execution.coordinate_timeout_ms, 240_000),
  });
  try {
    for (const coordinate of manifest.coordinates) {
      const directory = coordinateDirectory(outputDirectory, coordinate);
      const receiptPath = join(directory, "coordinate.json");
      if (existsSync(receiptPath)) {
        const existing = readJson<CoordinateResult>(receiptPath);
        if (existing.manifest_sha256 !== manifest.manifest_sha256) {
          throw new Error(`resume receipt belongs to another manifest: ${receiptPath}`);
        }
        continue;
      }
      let result: CoordinateResult | null = null;
      for (let attempt = 0; attempt <= manifest.execution.infrastructure_retry_limit; attempt += 1) {
        result = await runCoordinateAttempt({
          manifest,
          coordinate,
          attempt,
          output_directory: outputDirectory,
          host_proxy: hostProxy,
          allowed_nonces: allowedNonces,
        });
        if (result.validity.valid || !result.infrastructure_retryable) break;
      }
      if (!result) throw new Error("coordinate produced no result");
      writeAtomic(receiptPath, canonicalJson(result));
      process.stdout.write(
        `${coordinate.case_id} trial=${coordinate.trial_index} arm=${coordinate.arm} valid=${result.validity.valid} pass=${result.passed}\n`,
      );
    }
  } finally {
    hostProxy.stop();
  }
  const results = loadCoordinateResults(manifest, outputDirectory);
  const analysis = analyzeCampaignResults(manifest, results);
  writeAtomic(join(outputDirectory, "analysis.json"), canonicalJson(analysis));
  process.stdout.write(canonicalJson(analysis));
}

function coordinateResultPath(
  outputDirectory: string,
  coordinate: CoordinateIdentity,
): string {
  return join(coordinateDirectory(outputDirectory, coordinate), "coordinate.json");
}

function loadCoordinateResults(
  manifest: FrozenCampaignManifest,
  outputDirectory: string,
): CoordinateResult[] {
  return manifest.coordinates.flatMap((coordinate) => {
    const path = coordinateResultPath(outputDirectory, coordinate);
    return existsSync(path) ? [readJson<CoordinateResult>(path)] : [];
  });
}

interface ArmOverhead {
  runs: number;
  valid_runs: number;
  pass_rate: number;
  verification_command_rate: number;
  reminder_rate: number;
  treatment_exposure_rate: number;
  mean_steps: number;
  mean_latency_ms: number;
  mean_input_tokens: number;
  mean_output_tokens: number;
}

function overheadForArm(results: readonly CoordinateResult[]): ArmOverhead {
  const valid = results.filter((result) => result.validity.valid);
  const mean = (values: number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    runs: results.length,
    valid_runs: valid.length,
    pass_rate: valid.length === 0 ? 0 : valid.filter((result) => result.passed).length / valid.length,
    verification_command_rate: valid.length === 0 ? 0 : valid.filter(
      (result) => result.validity.verification_commands.length > 0,
    ).length / valid.length,
    reminder_rate: valid.length === 0 ? 0 : valid.filter(
      (result) => result.validity.reminder_count > 0,
    ).length / valid.length,
    treatment_exposure_rate: valid.length === 0 ? 0 : valid.filter(
      (result) => result.validity.treatment_exposed,
    ).length / valid.length,
    mean_steps: mean(valid.map((result) => result.headless?.steps ?? 0)),
    mean_latency_ms: mean(valid.map((result) => result.process.duration_ms)),
    mean_input_tokens: mean(valid.map((result) => result.validity.tokens.input)),
    mean_output_tokens: mean(valid.map((result) => result.validity.tokens.output)),
  };
}

function pairedOutcomes(
  manifest: FrozenCampaignManifest,
  results: readonly CoordinateResult[],
  left: AbSide | PilotArm,
  right: AbSide | PilotArm,
  kind: VerificationCase["kind"],
): PairedOutcome[] {
  const testCases = new Map(casesForPhase(manifest.phase).map((value) => [value.id, value]));
  const map = new Map<string, CoordinateResult>();
  for (const result of results) {
    map.set(`${result.coordinate.case_id}:${result.coordinate.trial_index}:${result.coordinate.arm}`, result);
  }
  const pairs: PairedOutcome[] = [];
  for (const testCase of testCases.values()) {
    if (testCase.kind !== kind) continue;
    for (let trial = 0; trial < manifest.trials_per_case; trial += 1) {
      const leftResult = map.get(`${testCase.id}:${trial}:${left}`);
      const rightResult = map.get(`${testCase.id}:${trial}:${right}`);
      if (!leftResult?.validity.valid || !rightResult?.validity.valid) continue;
      pairs.push({
        case_id: testCase.id,
        trial_index: trial,
        kind,
        baseline_passed: leftResult.passed,
        candidate_passed: rightResult.passed,
      });
    }
  }
  return pairs;
}

export function analyzeCampaignResults(
  manifest: FrozenCampaignManifest,
  results: readonly CoordinateResult[],
): Record<string, unknown> {
  const arms = manifest.phase === "pilot"
    ? (["baseline", "instructed", "candidate"] as const)
    : (["baseline", "candidate"] as const);
  const overhead = Object.fromEntries(arms.map((arm) => [
    arm,
    overheadForArm(results.filter((result) => result.coordinate.arm === arm)),
  ]));
  const candidateMutationPairs = pairedOutcomes(
    manifest,
    results,
    "baseline",
    "candidate",
    "mutation",
  );
  const candidateControls = pairedOutcomes(
    manifest,
    results,
    "baseline",
    "candidate",
    "read-only",
  );
  const candidateStats = summarizePairs(candidateMutationPairs);
  const controlStats = summarizePairs(candidateControls);
  const expectedMutationPairs = casesForPhase(manifest.phase).filter(
    (value) => value.kind === "mutation",
  ).length * manifest.trials_per_case;
  const expectedControlPairs = casesForPhase(manifest.phase).filter(
    (value) => value.kind === "read-only",
  ).length * manifest.trials_per_case;
  const analysis: Record<string, unknown> = {
    schema_version: 1,
    manifest_sha256: manifest.manifest_sha256,
    phase: manifest.phase,
    results: results.length,
    expected_results: manifest.coordinates.length,
    valid_results: results.filter((result) => result.validity.valid).length,
    overhead,
    candidate_vs_baseline: {
      mutation: candidateStats,
      mutation_expected_pairs: expectedMutationPairs,
      controls: controlStats,
      control_expected_pairs: expectedControlPairs,
    },
  };
  if (manifest.phase === "pilot") {
    const instructedPairs = pairedOutcomes(
      manifest,
      results,
      "baseline",
      "instructed",
      "mutation",
    );
    analysis.instructed_vs_baseline = summarizePairs(instructedPairs);
    analysis.pilot_decision = candidateMutationPairs.length === expectedMutationPairs &&
        candidateStats.candidate_passes > candidateStats.baseline_passes
      ? "candidate-signal-freeze-final"
      : "no-candidate-signal-stop-before-final";
  } else {
    const positive = candidateMutationPairs.length === expectedMutationPairs &&
      candidateStats.lift_ci_95[0] > 0 &&
      candidateStats.mcnemar_exact_p < 0.05 &&
      controlStats.candidate_passes >= controlStats.baseline_passes;
    analysis.disposition = positive
      ? "positive-replicate-across-model-family"
      : "null-or-negative-narrow-remove-or-default-off";
  }
  return analysis;
}

async function imageUserProbe(image: string): Promise<string> {
  const result = requireSuccess(await docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "1000:1000",
    image,
    "/bin/sh",
    "-lc",
    "test \"$(id -u)\" = 1000 && test \"$(id -g)\" = 1000 && getent passwd 1000",
  ]), "image UID/passwd probe");
  const line = result.stdout.trim();
  const fields = line.split(":");
  if (fields[0] !== "bun" || fields[2] !== "1000" || fields[3] !== "1000" || !["/bin/sh", "/bin/bash"].includes(fields[6] ?? "")) {
    throw new Error(`image user probe did not return a baked login shell: ${line}`);
  }
  return line;
}

async function binaryVersion(image: string, path: string): Promise<string> {
  const result = requireSuccess(await docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "1000:1000",
    "-v",
    `${path}:/opt/fx/fx:ro`,
    image,
    "/opt/fx/fx",
    "--version",
  ]), `read binary version ${path}`);
  return result.stdout.trim();
}

function preflightDockerArgs(input: {
  image: string;
  workspace: string;
  home: string;
  evidence: string;
  binary: string;
  model: string;
}): string[] {
  return [
    "run",
    "--rm",
    ...hardenedContainerArgs("none"),
    ...isolatedHarnessMounts(),
    "-v",
    `${input.workspace}:/workspace`,
    "-v",
    `${input.home}:/home/bun`,
    "-v",
    `${input.evidence}:/evidence`,
    "-v",
    `${input.binary}:/opt/fx/fx:ro`,
    "-w",
    "/workspace",
    "-e",
    "HOME=/home/bun",
    "-e",
    "SHELL=/bin/sh",
    "-e",
    `FX_MODEL=${input.model}`,
    "-e",
    "FX_VERIFICATION_TIMEOUT_MS=60000",
    "-e",
    "FX_VERIFICATION_AGENT_STEPS=4",
    input.image,
    "bun",
    "/harness/verification-container.ts",
    "preflight",
  ];
}

async function runBinaryPreflight(input: {
  image: string;
  model: string;
  label: "baseline" | "candidate";
  binary: string;
  output_directory: string;
}): Promise<PreflightBinaryResult> {
  const identity = `preflight:${input.label}:${sha256File(input.binary)}:${input.model}`;
  const resources = new DockerResources(input.image);
  const workspace = resourceName("preflight-workspace", identity);
  const home = resourceName("preflight-home", identity);
  const evidence = resourceName("preflight-evidence", identity);
  const artifactDirectory = join(input.output_directory, input.label);
  mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  let processResult: ProcessResult = {
    stdout: "",
    stderr: "preflight did not start\n",
    code: null,
    signal: null,
    timed_out: false,
    duration_ms: 0,
  };
  const reasons: string[] = [];
  let shell: string | null = null;
  try {
    for (const volume of [workspace, home, evidence]) await resources.createVolume(volume);
    processResult = await docker(preflightDockerArgs({
      image: input.image,
      workspace,
      home,
      evidence,
      binary: input.binary,
      model: input.model,
    }), 120_000);
    writeAtomic(join(artifactDirectory, "fx-stdout.json"), processResult.stdout);
    writeAtomic(join(artifactDirectory, "fx-stderr.txt"), processResult.stderr);
    writeAtomic(join(artifactDirectory, "raw-process.json"), canonicalJson(processResult));
    const evidenceSnapshot = resourceName("preflight-evidence-snapshot", identity);
    await snapshotNamedVolume(resources, evidence, evidenceSnapshot, "pilot-temp-cleanup");
    await exportTrustedVolume(
      resources,
      evidenceSnapshot,
      join(artifactDirectory, "evidence"),
      `${identity}:evidence`,
    );
  } catch (error) {
    reasons.push(`preflight_persistence:${error instanceof Error ? error.message : String(error)}`);
  }
  let headless: HeadlessResult | null = null;
  try {
    headless = JSON.parse(processResult.stdout.trim()) as HeadlessResult;
  } catch {
    reasons.push("malformed_headless_json");
  }
  const logPath = join(artifactDirectory, "evidence", "local-proxy.jsonl");
  let events: ProxyEvent[] = [];
  try {
    events = parseJsonLines(logPath);
  } catch {
    reasons.push("malformed_preflight_proxy_log");
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.preflight_shell) {
      shell = events[index]!.preflight_shell!;
      break;
    }
  }
  const tracePath = join(artifactDirectory, "evidence", "fx.trace");
  const trace = existsSync(tracePath) ? readFileSync(tracePath, "utf8") : "";
  if (processResult.code !== 0 || processResult.timed_out) reasons.push("preflight_process_failed");
  const expectedStderr =
    "Running printf 'fx-terminal-preflight:%s\\n' \"$SHELL\"\n" +
    "fx-terminal-preflight:/bin/sh\n";
  if (processResult.stderr !== expectedStderr) {
    reasons.push("preflight_stderr_not_clean");
  }
  if (headless?.exit_code !== 0 || headless?.error) reasons.push("preflight_headless_failed");
  if (headless?.output !== "terminal-preflight-complete") reasons.push("preflight_final_output_mismatch");
  if (!headless?.tool_calls?.some((call) =>
    call.name === "terminal" && call.status === "success" && call.command_result?.exit_code === 0
  )) reasons.push("terminal_tool_did_not_succeed");
  if (shell !== "/bin/sh" && shell !== "/bin/bash") reasons.push("terminal_shell_marker_missing");
  if (events.some((event) => event.outcome === "rejected" || event.outcome === "upstream-error")) {
    reasons.push("preflight_proxy_rejected_request");
  }
  if (`${processResult.stdout}\n${processResult.stderr}\n${trace}`.includes("MissingLoginShell")) {
    reasons.push("missing_login_shell");
  }
  await resources.cleanup();
  return {
    label: input.label,
    path: input.binary,
    sha256: sha256File(input.binary),
    version: await binaryVersion(input.image, input.binary),
    process: processResult,
    shell,
    valid: reasons.length === 0,
    reasons,
    artifact_directory: artifactDirectory,
  };
}

function receiptHash(receipt: Omit<PreflightReceipt, "receipt_sha256">): string {
  return sha256Text(canonicalJson(receipt));
}

function validatePreflightReceipt(receipt: PreflightReceipt): void {
  const { receipt_sha256, ...withoutHash } = receipt;
  if (receiptHash(withoutHash) !== receipt_sha256) throw new Error("preflight receipt hash mismatch");
  if (!receipt.valid || receipt.binaries.some((binary) => !binary.valid)) {
    throw new Error("preflight receipt is not valid");
  }
}

async function runPreflight(args: readonly string[]): Promise<void> {
  const image = requirePinnedImageReference(requiredFlag(args, "--image"));
  const baseline = executableBinary(args, "--baseline-bin", "baseline binary");
  const candidate = executableBinary(args, "--candidate-bin", "candidate binary");
  const model = requiredFlag(args, "--model");
  const output = requiredAbsolutePath(args, "--output");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const digest = await inspectImageDigest(image);
  const userProbe = await imageUserProbe(image);
  const binaries: PreflightBinaryResult[] = [];
  for (const [label, binary] of [["baseline", baseline], ["candidate", candidate]] as const) {
    binaries.push(await runBinaryPreflight({ image, model, label, binary, output_directory: output }));
  }
  const withoutHash = {
    schema_version: 1 as const,
    created_at: new Date().toISOString(),
    image: { reference: image, digest, user_probe: userProbe },
    model,
    catalog_sha256: sha256Text(pinnedCatalogJson(model)),
    binaries,
    valid: binaries.every((binary) => binary.valid),
  };
  const receipt: PreflightReceipt = {
    ...withoutHash,
    receipt_sha256: receiptHash(withoutHash),
  };
  writeAtomic(join(output, "preflight.json"), canonicalJson(receipt));
  process.stdout.write(canonicalJson(receipt));
  if (!receipt.valid) process.exitCode = 1;
}

async function frozenBinary(
  image: string,
  path: string,
  revision: string,
): Promise<FrozenBinary> {
  return {
    path,
    sha256: sha256File(path),
    version: await binaryVersion(image, path),
    revision,
  };
}

async function freezeCampaign(args: readonly string[]): Promise<void> {
  const phase = requiredFlag(args, "--phase") as CampaignPhase;
  if (phase !== "pilot" && phase !== "final") throw new Error("--phase must be pilot or final");
  const image = requirePinnedImageReference(requiredFlag(args, "--image"));
  const imageDigest = await inspectImageDigest(image);
  const baseline = executableBinary(args, "--baseline-bin", "baseline binary");
  const candidate = executableBinary(args, "--candidate-bin", "candidate binary");
  const model = requiredFlag(args, "--model");
  const preflightPath = requiredAbsolutePath(args, "--preflight");
  const preflight = readJson<PreflightReceipt>(preflightPath);
  validatePreflightReceipt(preflight);
  if (preflight.image.digest !== imageDigest || preflight.model !== model) {
    throw new Error("preflight image or model does not match freeze inputs");
  }
  const preflightHashes = new Map(preflight.binaries.map((binary) => [binary.label, binary.sha256]));
  if (preflightHashes.get("baseline") !== sha256File(baseline) ||
      preflightHashes.get("candidate") !== sha256File(candidate)) {
    throw new Error("preflight binary hashes do not match freeze inputs");
  }
  const trialsRaw = optionalFlag(args, "--trials");
  const trials = trialsRaw ? Number(trialsRaw) : undefined;
  if (phase === "final" && trials !== undefined && trials !== FINAL_TRIALS_PER_CASE) {
    throw new Error(`final campaign requires exactly ${FINAL_TRIALS_PER_CASE} trials per case`);
  }
  const upstream = optionalFlag(args, "--upstream") ?? DEFAULT_UPSTREAM;
  const manifest = buildFrozenManifest({
    phase,
    created_at: new Date().toISOString(),
    preflight_sha256: preflight.receipt_sha256,
    image_reference: image,
    image_digest: imageDigest,
    gateway_upstream: upstream,
    model,
    catalog_json: pinnedCatalogJson(model),
    baseline: await frozenBinary(image, baseline, requiredFlag(args, "--baseline-revision")),
    candidate: await frozenBinary(image, candidate, requiredFlag(args, "--candidate-revision")),
    trials_per_case: trials,
  });
  const output = requiredAbsolutePath(args, "--output");
  if (existsSync(output)) throw new Error(`refusing to overwrite frozen manifest: ${output}`);
  writeAtomic(output, canonicalJson(manifest));
  process.stdout.write(canonicalJson(manifest));
}

async function verifyFrozenRuntime(manifest: FrozenCampaignManifest): Promise<void> {
  const digest = await inspectImageDigest(manifest.image.reference);
  if (digest !== manifest.image.digest) throw new Error("frozen image digest changed");
  for (const binary of [manifest.binaries.baseline, manifest.binaries.candidate]) {
    requireAbsoluteExecutableBinary(binary.path, "frozen binary");
    if (sha256File(binary.path) !== binary.sha256) {
      throw new Error(`frozen binary hash changed: ${binary.path}`);
    }
  }
  if (sha256Text(pinnedCatalogJson(manifest.gateway.model)) !== manifest.gateway.catalog_sha256) {
    throw new Error("pinned catalog changed after freeze");
  }
}

function smokeSse(events: readonly object[]): Response {
  const body =
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function runDockerSmoke(args: readonly string[]): Promise<void> {
  const image = requirePinnedImageReference(requiredFlag(args, "--image"));
  const baselinePath = executableBinary(args, "--baseline-bin", "baseline binary");
  const candidatePath = executableBinary(args, "--candidate-bin", "candidate binary");
  const model = requiredFlag(args, "--model");
  const output = requiredAbsolutePath(args, "--output");
  if (existsSync(output)) throw new Error(`refusing to overwrite smoke artifacts: ${output}`);
  const preflight = readJson<PreflightReceipt>(
    requiredAbsolutePath(args, "--preflight"),
  );
  validatePreflightReceipt(preflight);
  const imageDigest = await inspectImageDigest(image);
  if (preflight.image.digest !== imageDigest || preflight.model !== model) {
    throw new Error("smoke inputs do not match the preflight receipt");
  }
  const preflightHashes = new Map(
    preflight.binaries.map((binary) => [binary.label, binary.sha256]),
  );
  if (
    preflightHashes.get("baseline") !== sha256File(baselinePath) ||
    preflightHashes.get("candidate") !== sha256File(candidatePath)
  ) {
    throw new Error("smoke binary hashes do not match the preflight receipt");
  }

  const smokeCase = caseById("pilot-settled-count");
  const correctSource = smokeCase.correct_files["counter.ts"];
  if (!correctSource) throw new Error("smoke fixture is missing reference source");
  let completion = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: PROXY_IDLE_TIMEOUT_SECONDS,
    async fetch(request) {
      const authorization = request.headers.get("authorization");
      if (authorization !== "Bearer smoke-host-secret") {
        return new Response("credential isolation failed", { status: 401 });
      }
      await request.text();
      completion += 1;
      const finish = {
        type: "finish",
        finishReason: {
          unified: completion < 3 ? "tool-calls" : "stop",
          raw: completion < 3 ? "tool-calls" : "stop",
        },
        usage: {
          inputTokens: { total: 10 },
          outputTokens: { total: 3 },
        },
      };
      if (completion === 1) {
        return smokeSse([
          { type: "response-metadata", modelId: model },
          {
            type: "tool-call",
            toolCallId: "smoke_write",
            toolName: "write_file",
            input: { path: "counter.ts", content: correctSource },
          },
          finish,
        ]);
      }
      if (completion === 2) {
        return smokeSse([
          { type: "response-metadata", modelId: model },
          {
            type: "tool-call",
            toolCallId: "smoke_verify",
            toolName: "terminal",
            input: {
              action: "exec",
              command: "bun test counter.test.ts",
            },
          },
          finish,
        ]);
      }
      if (completion === 3) {
        return smokeSse([
          { type: "response-metadata", modelId: model },
          { type: "text-start", id: "smoke_answer" },
          {
            type: "text-delta",
            id: "smoke_answer",
            delta: "Implemented the repair. bun test counter.test.ts passed.",
          },
          { type: "text-end", id: "smoke_answer" },
          finish,
        ]);
      }
      return new Response("unexpected smoke completion", { status: 500 });
    },
  });
  const manifest = buildFrozenManifest({
    phase: "pilot",
    created_at: new Date().toISOString(),
    preflight_sha256: preflight.receipt_sha256,
    image_reference: image,
    image_digest: imageDigest,
    gateway_upstream: `http://127.0.0.1:${upstream.port}${CHAT_PATH}`,
    model,
    catalog_json: pinnedCatalogJson(model),
    baseline: await frozenBinary(image, baselinePath, "smoke-baseline"),
    candidate: await frozenBinary(image, candidatePath, "smoke-candidate"),
    trials_per_case: 1,
    coordinate_timeout_ms: 60_000,
    infrastructure_retry_limit: 0,
    agent_step_limit: 6,
  });
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const allowedNonces = new Set<string>();
  const hostProxy = startHostGatewayProxy({
    upstream_url: manifest.gateway.upstream,
    credential: "smoke-host-secret",
    model,
    allowed_nonces: allowedNonces,
    hostname: "0.0.0.0",
    port: 0,
    timeout_ms: 60_000,
  });
  try {
    const result = await runCoordinateAttempt({
      manifest,
      coordinate: {
        case_id: smokeCase.id,
        trial_index: 0,
        order_index: 2,
        arm: "candidate",
      },
      attempt: 0,
      output_directory: output,
      host_proxy: hostProxy,
      allowed_nonces: allowedNonces,
    });
    const smoke = {
      schema_version: 1,
      valid: result.validity.valid &&
        result.validity.reminder_count === 1 &&
        result.grades.visible?.status === "passed" &&
        result.grades.held_out?.status === "passed" &&
        result.passed,
      result,
    };
    writeAtomic(join(output, "smoke.json"), canonicalJson(smoke));
    process.stdout.write(canonicalJson(smoke));
    if (!smoke.valid) process.exitCode = 1;
  } finally {
    hostProxy.stop();
    upstream.stop(true);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const args = process.argv.slice(3);
  if (command === "preflight") {
    await runPreflight(args);
    return;
  }
  if (command === "smoke") {
    await runDockerSmoke(args);
    return;
  }
  if (command === "freeze") {
    await freezeCampaign(args);
    return;
  }
  if (command === "run") {
    const manifest = readJson<FrozenCampaignManifest>(requiredAbsolutePath(args, "--manifest"));
    const output = requiredAbsolutePath(args, "--output");
    const credential = await resolveHostGatewayCredential();
    mkdirSync(output, { recursive: true, mode: 0o700 });
    await runCampaign(manifest, output, credential);
    return;
  }
  if (command === "analyze") {
    const manifest = readJson<FrozenCampaignManifest>(requiredAbsolutePath(args, "--manifest"));
    validateFrozenManifest(manifest);
    const output = requiredAbsolutePath(args, "--output");
    process.stdout.write(canonicalJson(
      analyzeCampaignResults(manifest, loadCoordinateResults(manifest, output)),
    ));
    return;
  }
  throw new Error(
    "usage: verification-ab.ts <preflight|smoke|freeze|run|analyze> [options]",
  );
}

if (import.meta.main) {
  await main();
}
