import {
  VERIFICATION_REMINDER,
  canonicalJson,
  sha256Text,
} from "./verification-common";
import {
  CORRECT_POOL_SOURCE,
  FLAWED_POOL_SOURCE,
  HELD_OUT_TEST_SOURCE,
  VISIBLE_TEST_SOURCE,
} from "./composed-lifecycle-eval";
import {
  createTrialOrder,
  type AbSide,
} from "./agent-quality-ab";
export { canonicalJson, sha256Text } from "./verification-common";

export const VERIFICATION_CAMPAIGN_SCHEMA_VERSION = 1;
export const FINAL_TRIALS_PER_CASE = 10;
export const PILOT_TRIALS_PER_CASE = 2;
export const MAX_FIXTURE_FILE_BYTES = 256 * 1024;
export const MAX_FIXTURE_TOTAL_BYTES = 2 * 1024 * 1024;

export const UPFRONT_VERIFICATION_INSTRUCTION = VERIFICATION_REMINDER;

export type CampaignPhase = "pilot" | "final";
export type VerificationCaseKind = "mutation" | "read-only";
export type PilotArm = "baseline" | "instructed" | "candidate";

export interface VerificationCase {
  id: string;
  phase: CampaignPhase;
  family: string;
  kind: VerificationCaseKind;
  prompt: string;
  initial_files: Readonly<Record<string, string>>;
  correct_files: Readonly<Record<string, string>>;
  visible_test_files: readonly string[];
  held_out_files: Readonly<Record<string, string>>;
  implementation_files: readonly string[];
  expected_output_fragments?: readonly string[];
  initial_visible_passes?: boolean;
}

const PACKAGE_JSON = `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`;

const CROSS_FILE_INITIAL_ORDER = `export interface LineItem {
  unitCents: number;
  quantity: number;
}

export function priceOrder(items: readonly LineItem[], discountCents: number): number {
  const subtotal = items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);
  return Math.max(0, subtotal - discountCents);
}
`;

const CROSS_FILE_CORRECT_ORDER = `export interface LineItem {
  unitCents: number;
  quantity: number;
}

export interface OrderPrice {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
}

export function priceOrder(
  items: readonly LineItem[],
  requestedDiscountCents: number,
): OrderPrice {
  const subtotalCents = items.reduce(
    (sum, item) => sum + item.unitCents * item.quantity,
    0,
  );
  const discountCents = Math.min(
    subtotalCents,
    Math.max(0, requestedDiscountCents),
  );
  return {
    subtotalCents,
    discountCents,
    totalCents: subtotalCents - discountCents,
  };
}
`;

const CROSS_FILE_INITIAL_REPORT = `import { priceOrder, type LineItem } from "./order";

export function renderReceipt(items: readonly LineItem[], discountCents: number): string {
  const total = priceOrder(items, discountCents);
  return \`Total: \${total}\`;
}
`;

const CROSS_FILE_CORRECT_REPORT = `import { priceOrder, type LineItem } from "./order";

export function renderReceipt(items: readonly LineItem[], discountCents: number): string {
  const price = priceOrder(items, discountCents);
  return \`Subtotal: \${price.subtotalCents}; Discount: \${price.discountCents}; Total: \${price.totalCents}\`;
}
`;

const CROSS_FILE_INITIAL_AUDIT = `import { priceOrder, type LineItem } from "./order";

export function auditTotal(items: readonly LineItem[], discountCents: number): number {
  return priceOrder(items, discountCents);
}
`;

const CROSS_FILE_CORRECT_AUDIT = `import { priceOrder, type LineItem } from "./order";

export function auditTotal(items: readonly LineItem[], discountCents: number): number {
  return priceOrder(items, discountCents).totalCents;
}
`;

const CROSS_FILE_VISIBLE_TEST = `import { expect, test } from "bun:test";
import { priceOrder } from "./order";
import { renderReceipt } from "./report";

test("priceOrder returns the expanded public contract", () => {
  expect(priceOrder([{ unitCents: 700, quantity: 2 }], 250)).toEqual({
    subtotalCents: 1400,
    discountCents: 250,
    totalCents: 1150,
  });
  expect(renderReceipt([{ unitCents: 700, quantity: 2 }], 250)).toBe(
    "Subtotal: 1400; Discount: 250; Total: 1150",
  );
});
`;

const CROSS_FILE_HELD_OUT_TEST = `import { expect, test } from "bun:test";
import { auditTotal } from "./audit";
import { priceOrder } from "./order";

test("all callers consume the expanded price and discounts are bounded", () => {
  const items = [{ unitCents: 300, quantity: 2 }];
  expect(auditTotal(items, 900)).toBe(0);
  expect(priceOrder(items, -50)).toEqual({
    subtotalCents: 600,
    discountCents: 0,
    totalCents: 600,
  });
});
`;

const STORE_INITIAL = `export type JobState = "queued" | "running" | "finished" | "failed";

export interface JobRecord {
  id: string;
  state: JobState;
}

export interface JobPersistence {
  save(records: readonly JobRecord[]): Promise<void>;
}

export class JobStore {
  #records: JobRecord[];

  constructor(records: readonly JobRecord[], private readonly persistence: JobPersistence) {
    this.#records = records.map((record) => ({ ...record }));
  }

  snapshot(): JobRecord[] {
    return this.#records.map((record) => ({ ...record }));
  }

  async transition(id: string, next: JobState): Promise<void> {
    const record = this.#records.find((candidate) => candidate.id === id);
    if (!record) throw new Error(\`unknown job: \${id}\`);
    record.state = next;
    await this.persistence.save(this.snapshot());
  }
}
`;

const STORE_CORRECT = `export type JobState = "queued" | "running" | "finished" | "failed";

export interface JobRecord {
  id: string;
  state: JobState;
}

export interface JobPersistence {
  save(records: readonly JobRecord[]): Promise<void>;
}

const ALLOWED: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ["running", "failed"],
  running: ["finished", "failed"],
  finished: [],
  failed: [],
};

export class JobStore {
  #records: JobRecord[];

  constructor(records: readonly JobRecord[], private readonly persistence: JobPersistence) {
    this.#records = records.map((record) => ({ ...record }));
  }

  snapshot(): JobRecord[] {
    return this.#records.map((record) => ({ ...record }));
  }

  async transition(id: string, next: JobState): Promise<void> {
    const index = this.#records.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new Error(\`unknown job: \${id}\`);
    const current = this.#records[index]!;
    if (!ALLOWED[current.state].includes(next)) {
      throw new Error(\`invalid transition: \${current.state} -> \${next}\`);
    }

    const proposed = this.snapshot();
    proposed[index] = { ...current, state: next };
    await this.persistence.save(proposed);
    this.#records = proposed;
  }
}
`;

const STORE_VISIBLE_TEST = `import { expect, test } from "bun:test";
import { JobStore, type JobRecord } from "./job-store";

test("transition persists and publishes a valid state change", async () => {
  const saved: JobRecord[][] = [];
  const store = new JobStore([{ id: "a", state: "queued" }], {
    async save(records) {
      saved.push(records.map((record) => ({ ...record })));
    },
  });

  await store.transition("a", "running");
  expect(saved).toEqual([[{ id: "a", state: "running" }]]);
  expect(store.snapshot()).toEqual([{ id: "a", state: "running" }]);
});
`;

const STORE_HELD_OUT_TEST = `import { expect, test } from "bun:test";
import { JobStore } from "./job-store";

test("failed persistence and invalid transitions leave published state unchanged", async () => {
  const failure = new Error("disk full");
  const store = new JobStore([{ id: "a", state: "queued" }], {
    async save() {
      throw failure;
    },
  });

  await expect(store.transition("a", "running")).rejects.toBe(failure);
  expect(store.snapshot()).toEqual([{ id: "a", state: "queued" }]);

  const terminal = new JobStore([{ id: "b", state: "finished" }], {
    async save() {
      throw new Error("must not save invalid transition");
    },
  });
  await expect(terminal.transition("b", "running")).rejects.toThrow(
    "invalid transition: finished -> running",
  );
  expect(terminal.snapshot()).toEqual([{ id: "b", state: "finished" }]);
});
`;

const CODEC_INITIAL = `export interface FeatureFlags {
  retries: number;
  verbose: boolean;
  label: string;
}

export function encodeFlags(flags: FeatureFlags): string {
  const value: Record<string, unknown> = {};
  if (flags.retries) value.retries = flags.retries;
  if (flags.verbose) value.verbose = flags.verbose;
  if (flags.label) value.label = flags.label;
  return JSON.stringify(value);
}

export function decodeFlags(raw: string): FeatureFlags {
  const value = JSON.parse(raw) as Partial<FeatureFlags>;
  return {
    retries: value.retries ?? 3,
    verbose: value.verbose ?? true,
    label: value.label ?? "default",
  };
}
`;

const CODEC_CORRECT = `export interface FeatureFlags {
  retries: number;
  verbose: boolean;
  label: string;
}

export function encodeFlags(flags: FeatureFlags): string {
  return JSON.stringify({
    retries: flags.retries,
    verbose: flags.verbose,
    label: flags.label,
  });
}

export function decodeFlags(raw: string): FeatureFlags {
  const value = JSON.parse(raw) as Partial<FeatureFlags>;
  return {
    retries: value.retries ?? 3,
    verbose: value.verbose ?? true,
    label: value.label ?? "default",
  };
}
`;

const CODEC_VISIBLE_TEST = `import { expect, test } from "bun:test";
import { decodeFlags, encodeFlags } from "./flags-codec";

test("flags survive a JSON round trip", () => {
  const flags = { retries: 5, verbose: true, label: "release" };
  expect(decodeFlags(encodeFlags(flags))).toEqual(flags);
});
`;

const CODEC_HELD_OUT_TEST = `import { expect, test } from "bun:test";
import { decodeFlags, encodeFlags } from "./flags-codec";

test("falsy values survive a JSON round trip", () => {
  const flags = { retries: 0, verbose: false, label: "" };
  expect(decodeFlags(encodeFlags(flags))).toEqual(flags);
  expect(JSON.parse(encodeFlags(flags))).toEqual(flags);
});
`;

const TEMP_INITIAL = `export interface TempBackend {
  create(): Promise<string>;
  remove(path: string): Promise<void>;
}

export async function withTemp<T>(
  backend: TempBackend,
  use: (path: string) => Promise<T>,
): Promise<T> {
  const path = await backend.create();
  const result = await use(path);
  await backend.remove(path);
  return result;
}
`;

const TEMP_CORRECT = `export interface TempBackend {
  create(): Promise<string>;
  remove(path: string): Promise<void>;
}

export async function withTemp<T>(
  backend: TempBackend,
  use: (path: string) => Promise<T>,
): Promise<T> {
  const path = await backend.create();
  try {
    return await use(path);
  } finally {
    await backend.remove(path);
  }
}
`;

const TEMP_VISIBLE_TEST = `import { expect, test } from "bun:test";
import { withTemp } from "./with-temp";

test("withTemp removes a successful allocation", async () => {
  const events: string[] = [];
  await expect(withTemp({
    async create() { events.push("create"); return "/tmp/x"; },
    async remove(path) { events.push(\`remove:\${path}\`); },
  }, async (path) => {
    events.push(\`use:\${path}\`);
    return 42;
  })).resolves.toBe(42);
  expect(events).toEqual(["create", "use:/tmp/x", "remove:/tmp/x"]);
});
`;

const TEMP_HELD_OUT_TEST = `import { expect, test } from "bun:test";
import { withTemp } from "./with-temp";

test("withTemp awaits removal before rejecting with the callback error", async () => {
  const callbackError = new Error("callback failed");
  const events: string[] = [];
  const running = withTemp({
    async create() { return "/tmp/y"; },
    async remove(path) { await Bun.sleep(20); events.push(\`removed:\${path}\`); },
  }, async () => {
    throw callbackError;
  });
  await expect(running).rejects.toBe(callbackError);
  expect(events).toEqual(["removed:/tmp/y"]);
});
`;

const CONFIG_INITIAL = `export interface AppConfig {
  region: string;
  retries: number;
}

export function resolveConfig(input: {
  defaults: AppConfig;
  project?: Partial<AppConfig>;
  profile?: Partial<AppConfig>;
  env?: Partial<Record<"region" | "retries", string>>;
}): AppConfig {
  const merged = {
    ...input.defaults,
    ...input.profile,
    ...input.project,
  };
  return {
    region: input.env?.region || merged.region,
    retries: Number(input.env?.retries || merged.retries),
  };
}
`;

const CONFIG_CORRECT = `export interface AppConfig {
  region: string;
  retries: number;
}

export function resolveConfig(input: {
  defaults: AppConfig;
  project?: Partial<AppConfig>;
  profile?: Partial<AppConfig>;
  env?: Partial<Record<"region" | "retries", string>>;
}): AppConfig {
  const merged = {
    ...input.defaults,
    ...input.project,
    ...input.profile,
  };
  const envRegion = input.env?.region?.trim();
  const envRetries = input.env?.retries?.trim();
  return {
    region: envRegion ? envRegion : merged.region,
    retries: envRetries ? Number(envRetries) : merged.retries,
  };
}
`;

const CONFIG_VISIBLE_TEST = `import { expect, test } from "bun:test";
import { resolveConfig } from "./config";

test("environment overrides profile, project, and defaults", () => {
  expect(resolveConfig({
    defaults: { region: "default", retries: 1 },
    project: { region: "project", retries: 2 },
    profile: { region: "profile", retries: 3 },
    env: { region: "env", retries: "4" },
  })).toEqual({ region: "env", retries: 4 });
});
`;

const CONFIG_HELD_OUT_TEST = `import { expect, test } from "bun:test";
import { resolveConfig } from "./config";

test("profile beats project and blank environment values are absent", () => {
  expect(resolveConfig({
    defaults: { region: "default", retries: 1 },
    project: { region: "project", retries: 2 },
    profile: { region: "profile", retries: 3 },
    env: { region: "  ", retries: "" },
  })).toEqual({ region: "profile", retries: 3 });
});
`;

const SERIALIZER_INITIAL = `export type Event =
  | { type: "started"; at: number }
  | { type: "completed"; at: number; result: string }
  | { type: "failed"; at: number; error: string };

export function serializeEvents(events: readonly Event[]): string {
  return events.map((event) => JSON.stringify(event)).join("\\n");
}

export function parseEvents(raw: string): Event[] {
  return raw.split("\\n").map((line) => JSON.parse(line) as Event);
}
`;

const SERIALIZER_CORRECT = `export type Event =
  | { type: "started"; at: number }
  | { type: "completed"; at: number; result: string }
  | { type: "failed"; at: number; error: string };

export function serializeEvents(events: readonly Event[]): string {
  if (events.length === 0) return "";
  return events.map((event) => JSON.stringify(event)).join("\\n") + "\\n";
}

export function parseEvents(raw: string): Event[] {
  const normalized = raw.endsWith("\\n") ? raw.slice(0, -1) : raw;
  if (normalized.length === 0) return [];
  return normalized.split("\\n").map((line) => JSON.parse(line) as Event);
}
`;

const SERIALIZER_VISIBLE_TEST = `import { expect, test } from "bun:test";
import { parseEvents, serializeEvents } from "./event-log";

test("event logs round trip", () => {
  const events = [{ type: "completed" as const, at: 10, result: "ok" }];
  expect(parseEvents(serializeEvents(events))).toEqual(events);
});
`;

const SERIALIZER_HELD_OUT_TEST = `import { expect, test } from "bun:test";
import { parseEvents, serializeEvents } from "./event-log";

test("empty logs and canonical trailing newlines round trip", () => {
  expect(serializeEvents([])).toBe("");
  expect(parseEvents("")).toEqual([]);
  const events = [{ type: "failed" as const, at: 0, error: "" }];
  const encoded = serializeEvents(events);
  expect(encoded.endsWith("\\n")).toBe(true);
  expect(parseEvents(encoded)).toEqual(events);
});
`;

const makeMutationCase = (
  value: Omit<VerificationCase, "kind" | "expected_output_fragments">,
): VerificationCase => ({ ...value, kind: "mutation" });

export const FINAL_CASES: readonly VerificationCase[] = [
  makeMutationCase({
    id: "bounded-pool-drain",
    phase: "final",
    family: "concurrency-lifecycle-drain",
    prompt: `Repair the bounded task pool in this workspace. Its public contract requires bounded concurrency, input-order results, no queued starts after abort, and rejection only after cleanup settles for every job that did start. Inspect the implementation and tests, fix the contract, and add a regression test for any missing interaction you find. Do not look for or create hidden tests.`,
    initial_files: {
      "package.json": PACKAGE_JSON,
      "pool.ts": FLAWED_POOL_SOURCE,
      "pool.test.ts": VISIBLE_TEST_SOURCE,
    },
    correct_files: { "pool.ts": CORRECT_POOL_SOURCE },
    visible_test_files: ["pool.test.ts"],
    held_out_files: { "held-out.test.ts": HELD_OUT_TEST_SOURCE },
    implementation_files: ["pool.ts"],
  }),
  makeMutationCase({
    id: "cross-file-price-contract",
    phase: "final",
    family: "cross-file-api-compile",
    prompt: `Change priceOrder to return the documented { subtotalCents, discountCents, totalCents } result, clamp discounts to the inclusive range from zero through subtotal, and migrate every caller in src. Keep receipt text in the documented field order. Inspect the workspace and add regression coverage for any missed boundary.`,
    initial_files: {
      "package.json": PACKAGE_JSON,
      "src/order.ts": CROSS_FILE_INITIAL_ORDER,
      "src/report.ts": CROSS_FILE_INITIAL_REPORT,
      "src/audit.ts": CROSS_FILE_INITIAL_AUDIT,
      "src/order.test.ts": CROSS_FILE_VISIBLE_TEST,
    },
    correct_files: {
      "src/order.ts": CROSS_FILE_CORRECT_ORDER,
      "src/report.ts": CROSS_FILE_CORRECT_REPORT,
      "src/audit.ts": CROSS_FILE_CORRECT_AUDIT,
    },
    visible_test_files: ["src/order.test.ts"],
    held_out_files: { "src/held-out.test.ts": CROSS_FILE_HELD_OUT_TEST },
    initial_visible_passes: false,
    implementation_files: ["src/order.ts", "src/report.ts", "src/audit.ts"],
  }),
  makeMutationCase({
    id: "durable-job-transition",
    phase: "final",
    family: "persistence-error-transition",
    prompt: `Repair JobStore.transition. Valid transitions are queued to running or failed, and running to finished or failed. Terminal states cannot transition. A state becomes observable only after persistence succeeds; missing jobs, invalid transitions, and persistence failures must leave the published snapshot unchanged. Add regression coverage for the interaction you repair.`,
    initial_files: {
      "package.json": PACKAGE_JSON,
      "job-store.ts": STORE_INITIAL,
      "job-store.test.ts": STORE_VISIBLE_TEST,
    },
    correct_files: { "job-store.ts": STORE_CORRECT },
    visible_test_files: ["job-store.test.ts"],
    held_out_files: { "held-out.test.ts": STORE_HELD_OUT_TEST },
    implementation_files: ["job-store.ts"],
  }),
  makeMutationCase({
    id: "falsy-flags-roundtrip",
    phase: "final",
    family: "serialization-roundtrip",
    prompt: `Repair the FeatureFlags JSON codec so every valid value round trips exactly. Valid values include zero retries, false verbose, and an empty label; decoder defaults apply only when a property is absent. Add regression coverage for the boundary you repair.`,
    initial_files: {
      "package.json": PACKAGE_JSON,
      "flags-codec.ts": CODEC_INITIAL,
      "flags-codec.test.ts": CODEC_VISIBLE_TEST,
    },
    correct_files: { "flags-codec.ts": CODEC_CORRECT },
    visible_test_files: ["flags-codec.test.ts"],
    held_out_files: { "held-out.test.ts": CODEC_HELD_OUT_TEST },
    implementation_files: ["flags-codec.ts"],
  }),
  makeMutationCase({
    id: "temp-resource-cleanup",
    phase: "final",
    family: "resource-cleanup-error-path",
    prompt: `Repair withTemp so a successfully created resource is removed exactly once after the callback settles, including when the callback rejects. Removal must finish before the function settles, and the callback's value or error remains the result when removal succeeds. Add regression coverage for the missing lifecycle.`,
    initial_files: {
      "package.json": PACKAGE_JSON,
      "with-temp.ts": TEMP_INITIAL,
      "with-temp.test.ts": TEMP_VISIBLE_TEST,
    },
    correct_files: { "with-temp.ts": TEMP_CORRECT },
    visible_test_files: ["with-temp.test.ts"],
    held_out_files: { "held-out.test.ts": TEMP_HELD_OUT_TEST },
    implementation_files: ["with-temp.ts"],
  }),
  makeMutationCase({
    id: "layered-config-precedence",
    phase: "final",
    family: "configuration-precedence",
    prompt: `Repair resolveConfig. Precedence is environment, then profile, then project, then defaults. Blank or whitespace-only environment strings are absent rather than overrides. Keep numeric conversion at the environment boundary and add regression coverage for the missed precedence interaction.`,
    initial_files: {
      "package.json": PACKAGE_JSON,
      "config.ts": CONFIG_INITIAL,
      "config.test.ts": CONFIG_VISIBLE_TEST,
    },
    correct_files: { "config.ts": CONFIG_CORRECT },
    visible_test_files: ["config.test.ts"],
    held_out_files: { "held-out.test.ts": CONFIG_HELD_OUT_TEST },
    implementation_files: ["config.ts"],
  }),
  {
    id: "read-only-dependency-control",
    phase: "final",
    family: "read-only-dependency-analysis",
    kind: "read-only",
    prompt: `Inspect the three modules without modifying any file. Report the direct import edges in the exact form "api -> store, report -> api" and state which module owns persistence.`,
    initial_files: {
      "package.json": PACKAGE_JSON,
      "store.ts": `export function persist(value: string): string { return value; }\n`,
      "api.ts": `import { persist } from "./store";\nexport function save(value: string) { return persist(value); }\n`,
      "report.ts": `import { save } from "./api";\nexport function report(value: string) { return save(value); }\n`,
    },
    correct_files: {},
    visible_test_files: [],
    held_out_files: {},
    implementation_files: [],
    expected_output_fragments: ["api -> store, report -> api", "store"],
  },
  {
    id: "read-only-default-control",
    phase: "final",
    family: "read-only-contract-analysis",
    kind: "read-only",
    prompt: `Inspect settings.ts without modifying any file. State the fallback region and retry count in the exact form "fallback: iad1, retries: 3", then name the function that returns them.`,
    initial_files: {
      "package.json": PACKAGE_JSON,
      "settings.ts": `export interface Settings { region: string; retries: number; }\nexport function defaultSettings(): Settings { return { region: "iad1", retries: 3 }; }\n`,
    },
    correct_files: {},
    visible_test_files: [],
    held_out_files: {},
    implementation_files: [],
    expected_output_fragments: ["fallback: iad1, retries: 3", "defaultSettings"],
  },
] as const;

const PILOT_COUNTER_INITIAL = `export async function settledCount(tasks: readonly Promise<unknown>[]): Promise<number> {
  let count = 0;
  for (const task of tasks) {
    await task;
    count += 1;
  }
  return count;
}
`;
const PILOT_COUNTER_CORRECT = `export async function settledCount(tasks: readonly Promise<unknown>[]): Promise<number> {
  const outcomes = await Promise.allSettled(tasks);
  return outcomes.length;
}
`;
const PILOT_COUNTER_VISIBLE = `import { expect, test } from "bun:test"; import { settledCount } from "./counter"; test("counts successful tasks", async () => { expect(await settledCount([Promise.resolve(1), Promise.resolve(2)])).toBe(2); });\n`;
const PILOT_COUNTER_HELD = `import { expect, test } from "bun:test"; import { settledCount } from "./counter"; test("waits for every task despite rejection", async () => { let late = false; const bad = Promise.reject(new Error("x")); const slow = Bun.sleep(20).then(() => { late = true; }); expect(await settledCount([bad, slow])).toBe(2); expect(late).toBe(true); });\n`;

export const PILOT_CASES: readonly VerificationCase[] = [
  makeMutationCase({
    id: "pilot-settled-count",
    phase: "pilot",
    family: "pilot-concurrency",
    prompt: `Repair settledCount so it waits for every supplied promise and returns the number settled even when one rejects. Add regression coverage for the interaction.`,
    initial_files: { "package.json": PACKAGE_JSON, "counter.ts": PILOT_COUNTER_INITIAL, "counter.test.ts": PILOT_COUNTER_VISIBLE },
    correct_files: { "counter.ts": PILOT_COUNTER_CORRECT },
    visible_test_files: ["counter.test.ts"],
    held_out_files: { "held-out.test.ts": PILOT_COUNTER_HELD },
    implementation_files: ["counter.ts"],
  }),
  makeMutationCase({
    id: "pilot-empty-event-log",
    phase: "pilot",
    family: "pilot-serialization",
    prompt: `Repair the event log codec so empty logs decode to an empty list and non-empty logs have one canonical trailing newline while still round tripping. Add a regression test.`,
    initial_files: { "package.json": PACKAGE_JSON, "event-log.ts": SERIALIZER_INITIAL, "event-log.test.ts": SERIALIZER_VISIBLE_TEST },
    correct_files: { "event-log.ts": SERIALIZER_CORRECT },
    visible_test_files: ["event-log.test.ts"],
    held_out_files: { "held-out.test.ts": SERIALIZER_HELD_OUT_TEST },
    implementation_files: ["event-log.ts"],
  }),
  makeMutationCase({
    id: "pilot-temp-cleanup",
    phase: "pilot",
    family: "pilot-cleanup",
    prompt: `Repair withTemp so cleanup finishes on both callback success and callback failure. Preserve the callback result when cleanup succeeds and add regression coverage.`,
    initial_files: { "package.json": PACKAGE_JSON, "with-temp.ts": TEMP_INITIAL, "with-temp.test.ts": TEMP_VISIBLE_TEST },
    correct_files: { "with-temp.ts": TEMP_CORRECT },
    visible_test_files: ["with-temp.test.ts"],
    held_out_files: { "held-out.test.ts": TEMP_HELD_OUT_TEST },
    implementation_files: ["with-temp.ts"],
  }),
] as const;

export function casesForPhase(phase: CampaignPhase): readonly VerificationCase[] {
  return phase === "pilot" ? PILOT_CASES : FINAL_CASES;
}

export function caseById(id: string): VerificationCase {
  const found = [...PILOT_CASES, ...FINAL_CASES].find((value) => value.id === id);
  if (!found) throw new Error(`unknown verification case: ${id}`);
  return found;
}

export function createPilotOrder(trial_index: number): [PilotArm, PilotArm, PilotArm] {
  switch (trial_index % 3) {
    case 0:
      return ["baseline", "instructed", "candidate"];
    case 1:
      return ["instructed", "candidate", "baseline"];
    default:
      return ["candidate", "baseline", "instructed"];
  }
}

export function promptForArm(test_case: VerificationCase, arm: AbSide | PilotArm): string {
  if (arm !== "instructed") return test_case.prompt;
  return `${test_case.prompt}\n\n${UPFRONT_VERIFICATION_INSTRUCTION}`;
}


export function verificationCaseDigest(test_case: VerificationCase): string {
  return sha256Text(canonicalJson(test_case));
}

export interface FrozenBinary {
  path: string;
  sha256: string;
  version: string;
  revision: string;
}

export interface FrozenCampaignManifest {
  schema_version: number;
  phase: CampaignPhase;
  created_at: string;
  preflight_sha256: string;
  image: { reference: string; digest: string };
  gateway: { upstream: string; model: string; catalog_sha256: string };
  execution: {
    coordinate_timeout_ms: number;
    infrastructure_retry_limit: number;
    agent_step_limit: number;
  };
  binaries: { baseline: FrozenBinary; candidate: FrozenBinary };
  reminder_sha256: string;
  trials_per_case: number;
  cases: Array<{
    id: string;
    kind: VerificationCaseKind;
    family: string;
    prompt_sha256: string;
    fixture_sha256: string;
  }>;
  coordinates: Array<{
    case_id: string;
    trial_index: number;
    order_index: number;
    arm: AbSide | PilotArm;
  }>;
  manifest_sha256: string;
}

export interface FreezeManifestInput {
  phase: CampaignPhase;
  created_at: string;
  preflight_sha256: string;
  image_reference: string;
  image_digest: string;
  gateway_upstream: string;
  model: string;
  catalog_json: string;
  baseline: FrozenBinary;
  candidate: FrozenBinary;
  trials_per_case?: number;
  coordinate_timeout_ms?: number;
  infrastructure_retry_limit?: number;
  agent_step_limit?: number;
}

function trialsForPhase(phase: CampaignPhase): number {
  return phase === "final" ? FINAL_TRIALS_PER_CASE : PILOT_TRIALS_PER_CASE;
}

function frozenCasesForPhase(
  phase: CampaignPhase,
): FrozenCampaignManifest["cases"] {
  return casesForPhase(phase).map((test_case) => ({
    id: test_case.id,
    kind: test_case.kind,
    family: test_case.family,
    prompt_sha256: sha256Text(test_case.prompt),
    fixture_sha256: verificationCaseDigest(test_case),
  }));
}

function coordinatesForPhase(
  phase: CampaignPhase,
  trials: number,
): FrozenCampaignManifest["coordinates"] {
  const coordinates: FrozenCampaignManifest["coordinates"] = [];
  for (const test_case of casesForPhase(phase)) {
    for (let trial_index = 0; trial_index < trials; trial_index += 1) {
      const order = phase === "pilot"
        ? createPilotOrder(trial_index)
        : createTrialOrder(trial_index);
      order.forEach((arm, order_index) => {
        coordinates.push({ case_id: test_case.id, trial_index, order_index, arm });
      });
    }
  }
  return coordinates;
}

export function buildFrozenManifest(input: FreezeManifestInput): FrozenCampaignManifest {
  const trials = input.trials_per_case ?? trialsForPhase(input.phase);
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error(`trials_per_case must be a positive integer, got ${trials}`);
  }
  const without_hash = {
    schema_version: VERIFICATION_CAMPAIGN_SCHEMA_VERSION,
    phase: input.phase,
    created_at: input.created_at,
    preflight_sha256: input.preflight_sha256,
    image: { reference: input.image_reference, digest: input.image_digest },
    gateway: {
      upstream: input.gateway_upstream,
      model: input.model,
      catalog_sha256: sha256Text(input.catalog_json),
    },
    execution: {
      coordinate_timeout_ms: input.coordinate_timeout_ms ?? 300_000,
      infrastructure_retry_limit: input.infrastructure_retry_limit ?? 1,
      agent_step_limit: input.agent_step_limit ?? 20,
    },
    binaries: { baseline: input.baseline, candidate: input.candidate },
    reminder_sha256: sha256Text(UPFRONT_VERIFICATION_INSTRUCTION),
    trials_per_case: trials,
    cases: frozenCasesForPhase(input.phase),
    coordinates: coordinatesForPhase(input.phase, trials),
  };
  return {
    ...without_hash,
    manifest_sha256: sha256Text(canonicalJson(without_hash)),
  };
}

export function validateFrozenManifest(manifest: FrozenCampaignManifest): void {
  if (manifest.schema_version !== VERIFICATION_CAMPAIGN_SCHEMA_VERSION) {
    throw new Error(`unsupported manifest schema: ${manifest.schema_version}`);
  }
  if (manifest.phase !== "pilot" && manifest.phase !== "final") {
    throw new Error(`unsupported campaign phase: ${String(manifest.phase)}`);
  }
  const { manifest_sha256, ...without_hash } = manifest;
  const actual = sha256Text(canonicalJson(without_hash));
  if (actual !== manifest_sha256) {
    throw new Error(`manifest hash mismatch: expected ${manifest_sha256}, got ${actual}`);
  }
  const expectedTrials = trialsForPhase(manifest.phase);
  if (manifest.trials_per_case !== expectedTrials) {
    throw new Error(
      `${manifest.phase} campaign requires exactly ${expectedTrials} trials per case`,
    );
  }
  const expectedReminder = sha256Text(UPFRONT_VERIFICATION_INSTRUCTION);
  if (manifest.reminder_sha256 !== expectedReminder) {
    throw new Error("manifest reminder digest does not match the campaign source");
  }
  const expectedCases = frozenCasesForPhase(manifest.phase);
  if (canonicalJson(manifest.cases) !== canonicalJson(expectedCases)) {
    throw new Error("manifest cases do not match the frozen campaign source");
  }
  const expectedCoordinates = coordinatesForPhase(manifest.phase, expectedTrials);
  if (canonicalJson(manifest.coordinates) !== canonicalJson(expectedCoordinates)) {
    throw new Error("manifest coordinates do not match the frozen campaign design");
  }
}

export interface PairedOutcome {
  case_id: string;
  trial_index: number;
  kind: VerificationCaseKind;
  baseline_passed: boolean;
  candidate_passed: boolean;
}

export interface PairedStatistics {
  pairs: number;
  baseline_passes: number;
  candidate_passes: number;
  baseline_only: number;
  candidate_only: number;
  lift: number;
  lift_ci_95: [number, number];
  mcnemar_exact_p: number;
}

function binomialCoefficient(n: number, k: number): number {
  const bounded = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= bounded; index += 1) {
    result = (result * (n - bounded + index)) / index;
  }
  return result;
}

export function exactMcNemarP(baseline_only: number, candidate_only: number): number {
  const discordant = baseline_only + candidate_only;
  if (discordant === 0) return 1;
  const tail = Math.min(baseline_only, candidate_only);
  let probability = 0;
  for (let index = 0; index <= tail; index += 1) {
    probability += binomialCoefficient(discordant, index) * 0.5 ** discordant;
  }
  return Math.min(1, 2 * probability);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export function pairedLiftConfidenceInterval(
  pairs: readonly PairedOutcome[],
  samples = 20_000,
  seed = 0x46585631,
): [number, number] {
  if (pairs.length === 0) return [0, 0];
  if (!Number.isInteger(samples) || samples < 1) {
    throw new Error(`samples must be a positive integer, got ${samples}`);
  }
  const random = seededRandom(seed);
  const lifts = new Array<number>(samples);
  for (let sample = 0; sample < samples; sample += 1) {
    let sum = 0;
    for (let index = 0; index < pairs.length; index += 1) {
      const pair = pairs[Math.floor(random() * pairs.length)]!;
      sum += Number(pair.candidate_passed) - Number(pair.baseline_passed);
    }
    lifts[sample] = sum / pairs.length;
  }
  lifts.sort((left, right) => left - right);
  return [
    lifts[Math.floor((samples - 1) * 0.025)]!,
    lifts[Math.ceil((samples - 1) * 0.975)]!,
  ];
}

export function summarizePairs(pairs: readonly PairedOutcome[]): PairedStatistics {
  const baseline_passes = pairs.filter((pair) => pair.baseline_passed).length;
  const candidate_passes = pairs.filter((pair) => pair.candidate_passed).length;
  const baseline_only = pairs.filter(
    (pair) => pair.baseline_passed && !pair.candidate_passed,
  ).length;
  const candidate_only = pairs.filter(
    (pair) => !pair.baseline_passed && pair.candidate_passed,
  ).length;
  return {
    pairs: pairs.length,
    baseline_passes,
    candidate_passes,
    baseline_only,
    candidate_only,
    lift: pairs.length === 0 ? 0 : (candidate_passes - baseline_passes) / pairs.length,
    lift_ci_95: pairedLiftConfidenceInterval(pairs),
    mcnemar_exact_p: exactMcNemarP(baseline_only, candidate_only),
  };
}
