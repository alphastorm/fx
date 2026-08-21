import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHAT_PATH,
  CATALOG_PATH,
  pinnedCatalogJson,
  startFakePreflightGateway,
  startLocalForwarder,
} from "./verification-gateway-proxy";

const MAX_FX_OUTPUT_BYTES = 4 * 1024 * 1024;

interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function writeSettings(home: string): void {
  const fxDirectory = join(home, ".fx");
  mkdirSync(fxDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(fxDirectory, "settings.json"),
    `${JSON.stringify({
      permission_mode: "auto",
      sandbox: "none",
      auto_upgrade: false,
      permission: {
        bash: "allow",
        terminal: "allow",
        read: "allow",
        write: "allow",
        edit: "allow",
        copy_file: "allow",
        create_folder: "allow",
        delete_file: "allow",
        rename_file: "allow",
      },
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function fxEnvironment(home: string, model: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    USER: "bun",
    LOGNAME: "bun",
    SHELL: "/bin/sh",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    AI_GATEWAY_API_KEY: "container-placeholder",
    FX_AUTO_UPGRADE: "0",
    FX_DISABLE_KEYCHAIN: "1",
    FX_GATEWAY_BASE_URL: "http://127.0.0.1:43123",
    FX_GATEWAY_CHAT_URL: `http://127.0.0.1:43123${CHAT_PATH}`,
    FX_E2E_GATEWAY_MODELS_URL: `http://127.0.0.1:43123${CATALOG_PATH}`,
    FX_MAX_AGENT_STEPS: requiredEnv("FX_VERIFICATION_AGENT_STEPS"),
    FX_MODEL: model,
    FX_PERMISSION_MODE: "auto",
    FX_TRACE_LOG: "/evidence/fx.trace",
  };
}

async function verifyPinnedCatalog(baseUrl: string, model: string): Promise<void> {
  const response = await fetch(new URL(CATALOG_PATH, baseUrl), {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`pinned catalog preflight failed with HTTP ${response.status}`);
  }
  const body = await response.text();
  if (body !== pinnedCatalogJson(model)) {
    throw new Error("pinned catalog preflight returned unexpected metadata");
  }
}

async function runFx(prompt: string): Promise<ProcessResult> {
  const home = requiredEnv("HOME");
  const model = requiredEnv("FX_MODEL");
  const timeoutMs = Number(requiredEnv("FX_VERIFICATION_TIMEOUT_MS"));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("FX_VERIFICATION_TIMEOUT_MS must be a positive integer");
  }
  writeSettings(home);
  return await new Promise((resolvePromise, reject) => {
    const child = nodeSpawn(
      "/opt/fx/fx",
      [
        "ask",
        "--auto",
        "--json",
        "--no-save",
        "--timeout",
        String(timeoutMs),
        prompt,
      ],
      {
        cwd: "/workspace",
        env: fxEnvironment(home, model),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let outputLimitExceeded = false;
    let timedOut = false;
    const append = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > MAX_FX_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs + 15_000);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const suffix = outputLimitExceeded ? "fx output exceeded limit\n" : "";
      resolvePromise({
        stdout: Buffer.concat(stdout).toString(),
        stderr: `${Buffer.concat(stderr).toString()}${suffix}`,
        code,
        signal,
        timed_out: timedOut,
      });
    });
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const model = requiredEnv("FX_MODEL");
  const logPath = "/evidence/local-proxy.jsonl";
  const gateway = mode === "preflight"
    ? startFakePreflightGateway({ model, port: 43123, log_path: logPath })
    : mode === "coordinate"
    ? startLocalForwarder({
      nonce: requiredEnv("FX_VERIFICATION_NONCE"),
      relay_url: requiredEnv("FX_VERIFICATION_RELAY_URL"),
      port: 43123,
      log_path: logPath,
    })
    : null;
  if (!gateway) throw new Error("usage: verification-container.ts <preflight|coordinate>");
  try {
    await verifyPinnedCatalog(gateway.url, model);
    const prompt = mode === "preflight"
      ? "Use the terminal tool to perform the requested environment preflight."
      : requiredEnv("FX_VERIFICATION_PROMPT");
    const result = await runFx(prompt);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.timed_out) process.stderr.write("fx container execution timed out\n");
    process.exitCode = result.code ?? 1;
  } finally {
    gateway.stop();
  }
}

if (import.meta.main) {
  await main();
}
