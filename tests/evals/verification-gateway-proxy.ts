import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  VERIFICATION_REMINDER,
  canonicalJson,
  sha256Text,
} from "./verification-common";

export const CHAT_PATH = "/v3/ai/language-model";
export const CATALOG_PATH = "/coding-agent/v1/models";
export const PROXY_NONCE_HEADER = "x-fx-verification-nonce";
export const MAX_PROXY_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_PROXY_RESPONSE_BYTES = 16 * 1024 * 1024;
export const PROXY_IDLE_TIMEOUT_SECONDS = 255;

const FORWARDED_REQUEST_HEADERS = [
  "ai-language-model-id",
  "ai-language-model-specification-version",
  "ai-language-model-streaming",
  "accept",
  "ai-gateway-protocol-version",
  "content-type",
  "http-referer",
  "user-agent",
  "x-title",
  "x-session-affinity",
  "x-session-id",
] as const;

export interface PinnedCatalogModel {
  id: string;
  type: "language";
  tags: ["tool-use"];
  context_window: number;
  max_tokens: number;
}

export function validGatewayTeam(team: string): boolean {
  return team.length > 0 &&
    team.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(team);
}

export function pinnedCatalog(model: string): { data: [PinnedCatalogModel] } {
  if (!model || model.length > 256) throw new Error("invalid pinned model id");
  return {
    data: [{
      id: model,
      type: "language",
      tags: ["tool-use"],
      context_window: 128_000,
      max_tokens: 16_384,
    }],
  };
}

export function pinnedCatalogJson(model: string): string {
  return canonicalJson(pinnedCatalog(model));
}

export interface GatewayUsage {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface ObservedToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface GatewaySseEvidence {
  event_count: number;
  malformed_event_count: number;
  finished: boolean;
  usage: GatewayUsage;
  tool_calls: ObservedToolCall[];
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function tokenTotal(value: unknown): number {
  if (typeof value === "number") return nonNegativeNumber(value);
  if (value && typeof value === "object") {
    return nonNegativeNumber((value as Record<string, unknown>).total);
  }
  return 0;
}

export function parseGatewaySse(payload: string): GatewaySseEvidence {
  const usage: GatewayUsage = {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };
  const tool_calls: ObservedToolCall[] = [];
  const streamed = new Map<string, { name: string; input: string }>();
  let event_count = 0;
  let malformed_event_count = 0;
  let finished = false;

  for (const line of payload.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trimStart();
    if (!data || data === "[DONE]") continue;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        malformed_event_count += 1;
        continue;
      }
      event = parsed as Record<string, unknown>;
    } catch {
      malformed_event_count += 1;
      continue;
    }
    event_count += 1;
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "finish") {
      finished = true;
      const rawUsage = event.usage;
      if (rawUsage && typeof rawUsage === "object") {
        const value = rawUsage as Record<string, unknown>;
        usage.input_tokens += tokenTotal(value.inputTokens);
        usage.output_tokens += tokenTotal(value.outputTokens);
        if (value.inputTokens && typeof value.inputTokens === "object") {
          const input = value.inputTokens as Record<string, unknown>;
          usage.cache_read_tokens += nonNegativeNumber(input.cacheRead);
          usage.cache_write_tokens += nonNegativeNumber(input.cacheWrite);
        }
        if (value.outputTokens && typeof value.outputTokens === "object") {
          usage.reasoning_tokens += nonNegativeNumber(
            (value.outputTokens as Record<string, unknown>).reasoning,
          );
        }
      }
    }
    if (type === "tool-call") {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      const name = typeof event.toolName === "string" ? event.toolName : "";
      if (id && name) tool_calls.push({ id, name, input: event.input });
    }
    if (type === "tool-input-start") {
      const id = typeof event.id === "string"
        ? event.id
        : typeof event.toolCallId === "string"
        ? event.toolCallId
        : "";
      const name = typeof event.toolName === "string" ? event.toolName : "";
      if (id && name) streamed.set(id, { name, input: "" });
    }
    if (type === "tool-input-delta") {
      const id = typeof event.id === "string"
        ? event.id
        : typeof event.toolCallId === "string"
        ? event.toolCallId
        : "";
      const state = streamed.get(id);
      const delta = typeof event.delta === "string"
        ? event.delta
        : typeof event.inputTextDelta === "string"
        ? event.inputTextDelta
        : "";
      if (state) state.input += delta;
    }
    if (type === "tool-input-end") {
      const id = typeof event.id === "string"
        ? event.id
        : typeof event.toolCallId === "string"
        ? event.toolCallId
        : "";
      const state = streamed.get(id);
      if (state) {
        let input: unknown = state.input;
        try {
          input = JSON.parse(state.input);
        } catch {}
        tool_calls.push({ id, name: state.name, input });
        streamed.delete(id);
      }
    }
  }

  return { event_count, malformed_event_count, finished, usage, tool_calls };
}

export interface ProxyEvent {
  at: string;
  layer: "host" | "relay" | "local" | "fake";
  outcome: "forwarded" | "catalog" | "rejected" | "upstream-error";
  method: string;
  path: string;
  nonce_sha256?: string;
  request_bytes?: number;
  preflight_shell?: string;
  request_sha256?: string;
  upstream_status?: number;
  response_bytes?: number;
  evidence?: GatewaySseEvidence;
  verification_reminder_count?: number;
  reason?: string;
}

function recordEvent(events: ProxyEvent[], event: ProxyEvent, logPath?: string): void {
  events.push(event);
  if (logPath) {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }
}

function baseEvent(
  layer: ProxyEvent["layer"],
  outcome: ProxyEvent["outcome"],
  request: Request,
): ProxyEvent {
  return {
    at: new Date().toISOString(),
    layer,
    outcome,
    method: request.method,
    path: new URL(request.url).pathname,
  };
}

async function boundedRequestBody(request: Request): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length && Number(length) > MAX_PROXY_BODY_BYTES) {
    throw new Error("request body exceeds limit");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_PROXY_BODY_BYTES) {
    throw new Error("request body exceeds limit");
  }
  return bytes;
}

async function boundedResponseBody(response: Response): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > MAX_PROXY_RESPONSE_BYTES) {
    throw new Error("response body exceeds limit");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PROXY_RESPONSE_BYTES) {
    throw new Error("response body exceeds limit");
  }
  return bytes;
}

function byteBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function forwardedHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function responseHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of ["content-type", "cache-control", "x-request-id"]) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

interface RequestInspection {
  model_selectors: string[];
  verification_reminder_count: number;
}

function inspectRequest(request: Request, body: Uint8Array): RequestInspection | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const model_selectors: string[] = [];
  const header = request.headers.get("ai-language-model-id");
  if (header) model_selectors.push(header);
  const record = parsed as Record<string, unknown>;
  if (Object.hasOwn(record, "model")) {
    if (typeof record.model !== "string" || !record.model) return null;
    model_selectors.push(record.model);
  }
  if (model_selectors.length === 0) return null;

  let verification_reminder_count = 0;
  let visited = 0;
  const pending: unknown[] = [parsed];
  while (pending.length > 0) {
    const value = pending.pop();
    visited += 1;
    if (visited > 200_000) return null;
    if (value === VERIFICATION_REMINDER) {
      verification_reminder_count += 1;
    } else if (Array.isArray(value)) {
      pending.push(...value);
    } else if (value && typeof value === "object") {
      pending.push(...Object.values(value));
    }
  }
  return { model_selectors, verification_reminder_count };
}

function requestMatchesModel(
  inspection: RequestInspection | null,
  model: string,
): inspection is RequestInspection {
  return inspection !== null &&
    inspection.model_selectors.every((selector) => selector === model);
}

export interface HostGatewayProxyConfig {
  upstream_url: string;
  credential: string;
  gateway_team?: string;
  model: string;
  allowed_nonces: ReadonlySet<string>;
  port?: number;
  timeout_ms?: number;
  log_path?: string;
}

export interface RunningGatewayServer {
  url: string;
  events: ProxyEvent[];
  stop(): void;
}

export function startHostGatewayProxy(config: HostGatewayProxyConfig): RunningGatewayServer {
  if (!config.credential) throw new Error("host proxy credential is required");
  if (config.gateway_team && !validGatewayTeam(config.gateway_team)) {
    throw new Error("invalid host gateway team");
  }
  const upstream = new URL(config.upstream_url);
  if (upstream.protocol !== "https:" && upstream.hostname !== "127.0.0.1") {
    throw new Error("host proxy upstream must use HTTPS or loopback");
  }
  const events: ProxyEvent[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.port ?? 0,
    idleTimeout: PROXY_IDLE_TIMEOUT_SECONDS,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const nonce = request.headers.get(PROXY_NONCE_HEADER) ?? "";
      const nonceHash = nonce ? sha256Text(nonce) : undefined;
      const reject = (reason: string, status = 403): Response => {
        recordEvent(events, {
          ...baseEvent("host", "rejected", request),
          nonce_sha256: nonceHash,
          reason,
        }, config.log_path);
        return new Response(reason, { status });
      };
      if (!config.allowed_nonces.has(nonce)) return reject("invalid coordinate nonce");
      if (request.method !== "POST" || path !== CHAT_PATH) {
        return reject("unexpected host proxy route", 404);
      }
      let body: Uint8Array;
      try {
        body = await boundedRequestBody(request);
      } catch (error) {
        return reject(error instanceof Error ? error.message : String(error), 413);
      }
      const inspection = inspectRequest(request, body);
      if (!requestMatchesModel(inspection, config.model)) {
        return reject("unpinned request model", 400);
      }
      const headers = forwardedHeaders(request.headers);
      headers.set("authorization", `Bearer ${config.credential}`);
      headers.set("content-type", "application/json");
      if (config.gateway_team) {
        headers.set("x-vercel-ai-gateway-team", config.gateway_team);
      }
      const requestMetadata = {
        nonce_sha256: nonceHash,
        request_bytes: body.byteLength,
        request_sha256: sha256Text(body),
        verification_reminder_count: inspection.verification_reminder_count,
      };
      try {
        const response = await fetch(config.upstream_url, {
          method: "POST",
          headers,
          body: byteBody(body),
          signal: AbortSignal.timeout(config.timeout_ms ?? 240_000),
        });
        const responseBody = await boundedResponseBody(response);
        const contentType = response.headers.get("content-type") ?? "";
        const evidence = contentType.includes("text/event-stream")
          ? parseGatewaySse(new TextDecoder().decode(responseBody))
          : undefined;
        recordEvent(events, {
          ...baseEvent("host", response.ok ? "forwarded" : "upstream-error", request),
          ...requestMetadata,
          upstream_status: response.status,
          response_bytes: responseBody.byteLength,
          evidence,
          reason: response.ok ? undefined : `upstream HTTP ${response.status}`,
        }, config.log_path);
        return new Response(byteBody(responseBody), {
          status: response.status,
          headers: responseHeaders(response.headers),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        recordEvent(events, {
          ...baseEvent("host", "upstream-error", request),
          ...requestMetadata,
          reason,
        }, config.log_path);
        return new Response("gateway upstream failed", { status: 502 });
      }
    },
  });
  return {
    url: `http://${server.hostname}:${server.port}`,
    events,
    stop: () => server.stop(true),
  };
}

export interface RelayProxyConfig {
  nonce: string;
  host_proxy_url: string;
  model: string;
  hostname?: string;
  port?: number;
  timeout_ms?: number;
  log_path?: string;
}

export function startRelayProxy(config: RelayProxyConfig): RunningGatewayServer {
  if (!config.nonce) throw new Error("relay nonce is required");
  const hostProxy = new URL(config.host_proxy_url);
  const events: ProxyEvent[] = [];
  const server = Bun.serve({
    hostname: config.hostname ?? "0.0.0.0",
    port: config.port ?? 8787,
    idleTimeout: PROXY_IDLE_TIMEOUT_SECONDS,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const suppliedNonce = request.headers.get(PROXY_NONCE_HEADER) ?? "";
      const nonceHash = suppliedNonce ? sha256Text(suppliedNonce) : undefined;
      const reject = (reason: string, status = 403): Response => {
        recordEvent(events, {
          ...baseEvent("relay", "rejected", request),
          nonce_sha256: nonceHash,
          reason,
        }, config.log_path);
        return new Response(reason, { status });
      };
      if (suppliedNonce !== config.nonce) return reject("invalid coordinate nonce");
      if (request.method === "GET" && path === CATALOG_PATH) {
        const body = pinnedCatalogJson(config.model);
        recordEvent(events, {
          ...baseEvent("relay", "catalog", request),
          nonce_sha256: nonceHash,
          response_bytes: Buffer.byteLength(body),
        }, config.log_path);
        return new Response(body, { headers: { "content-type": "application/json" } });
      }
      if (request.method !== "POST" || path !== CHAT_PATH) {
        return reject("unexpected relay route", 404);
      }
      let body: Uint8Array;
      try {
        body = await boundedRequestBody(request);
      } catch (error) {
        return reject(error instanceof Error ? error.message : String(error), 413);
      }
      const headers = forwardedHeaders(request.headers);
      headers.set(PROXY_NONCE_HEADER, config.nonce);
      headers.set("content-type", "application/json");
      try {
        const target = new URL(CHAT_PATH, hostProxy);
        const response = await fetch(target, {
          method: "POST",
          headers,
          body: byteBody(body),
          signal: AbortSignal.timeout(config.timeout_ms ?? 245_000),
        });
        const responseBody = await boundedResponseBody(response);
        recordEvent(events, {
          ...baseEvent("relay", response.ok ? "forwarded" : "upstream-error", request),
          nonce_sha256: nonceHash,
          request_bytes: body.byteLength,
          request_sha256: sha256Text(body),
          upstream_status: response.status,
          response_bytes: responseBody.byteLength,
          reason: response.ok ? undefined : `host proxy HTTP ${response.status}`,
        }, config.log_path);
        return new Response(byteBody(responseBody), {
          status: response.status,
          headers: responseHeaders(response.headers),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        recordEvent(events, {
          ...baseEvent("relay", "upstream-error", request),
          nonce_sha256: nonceHash,
          request_bytes: body.byteLength,
          request_sha256: sha256Text(body),
          reason,
        }, config.log_path);
        return new Response("host proxy failed", { status: 502 });
      }
    },
  });
  return {
    url: `http://${server.hostname}:${server.port}`,
    events,
    stop: () => server.stop(true),
  };
}

export interface LocalForwarderConfig {
  nonce: string;
  relay_url: string;
  hostname?: string;
  port?: number;
  timeout_ms?: number;
  log_path?: string;
}

export function startLocalForwarder(config: LocalForwarderConfig): RunningGatewayServer {
  if (!config.nonce) throw new Error("local forwarder nonce is required");
  const relay = new URL(config.relay_url);
  const events: ProxyEvent[] = [];
  const server = Bun.serve({
    hostname: config.hostname ?? "127.0.0.1",
    port: config.port ?? 43123,
    idleTimeout: PROXY_IDLE_TIMEOUT_SECONDS,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const routeAllowed = (request.method === "GET" && path === CATALOG_PATH) ||
        (request.method === "POST" && path === CHAT_PATH);
      if (!routeAllowed) {
        recordEvent(events, {
          ...baseEvent("local", "rejected", request),
          reason: "unexpected local route",
        }, config.log_path);
        return new Response("unexpected local route", { status: 404 });
      }
      let body: Uint8Array | undefined;
      try {
        if (request.method === "POST") body = await boundedRequestBody(request);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        recordEvent(events, { ...baseEvent("local", "rejected", request), reason }, config.log_path);
        return new Response(reason, { status: 413 });
      }
      const headers = forwardedHeaders(request.headers);
      headers.set(PROXY_NONCE_HEADER, config.nonce);
      const target = new URL(path, relay);
      try {
        const response = await fetch(target, {
          method: request.method,
          headers,
          body: body ? byteBody(body) : undefined,
          signal: AbortSignal.timeout(config.timeout_ms ?? 250_000),
        });
        const responseBody = await boundedResponseBody(response);
        recordEvent(events, {
          ...baseEvent("local", response.ok ? (request.method === "GET" ? "catalog" : "forwarded") : "upstream-error", request),
          request_bytes: body?.byteLength,
          request_sha256: body ? sha256Text(body) : undefined,
          upstream_status: response.status,
          response_bytes: responseBody.byteLength,
          reason: response.ok ? undefined : `relay HTTP ${response.status}`,
        }, config.log_path);
        return new Response(byteBody(responseBody), {
          status: response.status,
          headers: responseHeaders(response.headers),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        recordEvent(events, {
          ...baseEvent("local", "upstream-error", request),
          reason,
        }, config.log_path);
        return new Response("relay failed", { status: 502 });
      }
    },
  });
  return {
    url: `http://${server.hostname}:${server.port}`,
    events,
    stop: () => server.stop(true),
  };
}

function fakeGatewaySse(events: object[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

export interface FakePreflightConfig {
  model: string;
  hostname?: string;
  port?: number;
  log_path?: string;
}

export function startFakePreflightGateway(config: FakePreflightConfig): RunningGatewayServer {
  const events: ProxyEvent[] = [];
  let completionCount = 0;
  const server = Bun.serve({
    hostname: config.hostname ?? "127.0.0.1",
    port: config.port ?? 43123,
    idleTimeout: PROXY_IDLE_TIMEOUT_SECONDS,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === CATALOG_PATH) {
        const body = pinnedCatalogJson(config.model);
        recordEvent(events, {
          ...baseEvent("fake", "catalog", request),
          response_bytes: Buffer.byteLength(body),
        }, config.log_path);
        return new Response(body, { headers: { "content-type": "application/json" } });
      }
      if (request.method !== "POST" || path !== CHAT_PATH) {
        recordEvent(events, {
          ...baseEvent("fake", "rejected", request),
          reason: "unexpected fake route",
        }, config.log_path);
        return new Response("unexpected fake route", { status: 404 });
      }
      const body = await boundedRequestBody(request);
      const inspection = inspectRequest(request, body);
      if (!requestMatchesModel(inspection, config.model)) {
        recordEvent(events, {
          ...baseEvent("fake", "rejected", request),
          request_bytes: body.byteLength,
          request_sha256: sha256Text(body),
          reason: "unpinned request model",
        }, config.log_path);
        return new Response("unpinned request model", { status: 400 });
      }
      const parsedBody = new TextDecoder().decode(body);
      const classifier = parsedBody.includes('"permission_decision"');
      if (!classifier) completionCount += 1;
      const preflightShell = parsedBody.match(
        /fx-terminal-preflight:(\/[A-Za-z0-9._/-]+)/,
      )?.[1];
      if (!classifier && completionCount > 1 && !preflightShell) {
        recordEvent(events, {
          ...baseEvent("fake", "rejected", request),
          request_bytes: body.byteLength,
          request_sha256: sha256Text(body),
          reason: "terminal preflight marker missing",
        }, config.log_path);
        return new Response("terminal preflight marker missing", { status: 400 });
      }
      const response = classifier
        ? fakeGatewaySse([
          {
            type: "tool-call",
            toolCallId: `permission_${events.length + 1}`,
            toolName: "permission_decision",
            input: {
              risk: "low",
              authorization: "medium",
              decision: "allow",
              rationale: "verification preflight fixture",
            },
          },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" } },
        ])
        : completionCount === 1
        ? fakeGatewaySse([
          {
            type: "response-metadata",
            modelId: config.model,
            timestamp: new Date().toISOString(),
          },
          {
            type: "tool-call",
            toolCallId: "terminal_preflight_1",
            toolName: "terminal",
            input: {
              action: "exec",
              command: "printf 'fx-terminal-preflight:%s\\n' \"$SHELL\"",
            },
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          },
        ])
        : fakeGatewaySse([
          { type: "text-start", id: "answer_1" },
          { type: "text-delta", id: "answer_1", delta: "terminal-preflight-complete" },
          { type: "text-end", id: "answer_1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          },
        ]);
      const responseBody = new Uint8Array(await response.arrayBuffer());
      recordEvent(events, {
        ...baseEvent("fake", "forwarded", request),
        request_bytes: body.byteLength,
        request_sha256: sha256Text(body),
        upstream_status: 200,
        response_bytes: responseBody.byteLength,
        evidence: parseGatewaySse(new TextDecoder().decode(responseBody)),
        preflight_shell: preflightShell,
      }, config.log_path);
      return new Response(byteBody(responseBody), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return {
    url: `http://${server.hostname}:${server.port}`,
    events,
    stop: () => server.stop(true),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  let running: RunningGatewayServer;
  if (mode === "relay") {
    running = startRelayProxy({
      nonce: requiredEnv("FX_VERIFICATION_NONCE"),
      host_proxy_url: requiredEnv("FX_VERIFICATION_HOST_PROXY_URL"),
      model: requiredEnv("FX_MODEL"),
      hostname: process.env.FX_VERIFICATION_LISTEN_HOST ?? "0.0.0.0",
      port: Number(process.env.FX_VERIFICATION_LISTEN_PORT ?? "8787"),
      log_path: process.env.FX_VERIFICATION_PROXY_LOG,
    });
  } else if (mode === "local") {
    running = startLocalForwarder({
      nonce: requiredEnv("FX_VERIFICATION_NONCE"),
      relay_url: requiredEnv("FX_VERIFICATION_RELAY_URL"),
      hostname: "127.0.0.1",
      port: Number(process.env.FX_VERIFICATION_LISTEN_PORT ?? "43123"),
      log_path: process.env.FX_VERIFICATION_PROXY_LOG,
    });
  } else if (mode === "fake") {
    running = startFakePreflightGateway({
      model: requiredEnv("FX_MODEL"),
      hostname: "127.0.0.1",
      port: Number(process.env.FX_VERIFICATION_LISTEN_PORT ?? "43123"),
      log_path: process.env.FX_VERIFICATION_PROXY_LOG,
    });
  } else {
    throw new Error("usage: verification-gateway-proxy.ts <relay|local|fake>");
  }
  process.stdout.write(`verification-proxy-ready ${mode} ${running.url}\n`);
  await new Promise<void>(() => {});
}

if (import.meta.main) {
  await main();
}
