import { afterEach, describe, expect, test } from "bun:test";
import {
  CATALOG_PATH,
  CHAT_PATH,
  PROXY_IDLE_TIMEOUT_SECONDS,
  PROXY_NONCE_HEADER,
  parseGatewaySse,
  pinnedCatalogJson,
  startFakePreflightGateway,
  startHostGatewayProxy,
  startLocalForwarder,
  startRelayProxy,
  type RunningGatewayServer,
} from "./verification-gateway-proxy";

const MODEL = "provider/frozen-model";
const NONCE = "coordinate-nonce-value";
const running: Array<{ stop(): void }> = [];

afterEach(() => {
  for (const server of running.splice(0).reverse()) server.stop();
});

function sse(events: object[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function completionBody(model = MODEL): string {
  return JSON.stringify({ model, messages: [{ role: "user", content: "fixture" }] });
}

function requestHeaders(nonce = NONCE): HeadersInit {
  return {
    "content-type": "application/json",
    [PROXY_NONCE_HEADER]: nonce,
    authorization: "Bearer container-dummy",
    "ai-gateway-protocol-version": "0.0.1",
    "ai-language-model-specification-version": "4",
    "ai-language-model-streaming": "true",
    "x-vercel-ai-gateway-team": "team-container",
  };
}

describe("gateway SSE evidence", () => {
  test("extracts usage and direct plus streamed tool calls", () => {
    const payload = sse([
      { type: "tool-call", toolCallId: "one", toolName: "terminal", input: { command: "bun test" } },
      { type: "tool-input-start", id: "two", toolName: "read_file" },
      { type: "tool-input-delta", id: "two", delta: '{"path":"a' },
      { type: "tool-input-delta", id: "two", delta: '.ts"}' },
      { type: "tool-input-end", id: "two" },
      {
        type: "finish",
        finishReason: { unified: "stop" },
        usage: {
          inputTokens: { total: 11, cacheRead: 3, cacheWrite: 2 },
          outputTokens: { total: 7, reasoning: 4 },
        },
      },
    ]);

    expect(parseGatewaySse(payload)).toEqual({
      event_count: 6,
      malformed_event_count: 0,
      finished: true,
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        reasoning_tokens: 4,
        cache_read_tokens: 3,
        cache_write_tokens: 2,
      },
      tool_calls: [
        { id: "one", name: "terminal", input: { command: "bun test" } },
        { id: "two", name: "read_file", input: { path: "a.ts" } },
      ],
    });
  });

  test("counts malformed events without inventing completion", () => {
    const evidence = parseGatewaySse("data: nope\n\ndata: []\n\n");
    expect(evidence.malformed_event_count).toBe(2);
    expect(evidence.finished).toBe(false);
    expect(evidence.event_count).toBe(0);
  });
});

describe("credential-isolating host proxy", () => {
  test("replaces container authorization and records bounded evidence", async () => {
    let authorization = "";
    let gatewayTeam = "";
    let requestCount = 0;
    let specificationVersion = "";
    let streaming = "";
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: PROXY_IDLE_TIMEOUT_SECONDS,
      async fetch(request) {
        requestCount += 1;
        authorization = request.headers.get("authorization") ?? "";
        gatewayTeam = request.headers.get("x-vercel-ai-gateway-team") ?? "";
        await request.text();
        specificationVersion =
          request.headers.get("ai-language-model-specification-version") ?? "";
        streaming = request.headers.get("ai-language-model-streaming") ?? "";
        return new Response(sse([
          { type: "tool-call", toolCallId: "verify", toolName: "terminal", input: { command: "bun test" } },
          {
            type: "finish",
            finishReason: { unified: "stop" },
            usage: { inputTokens: { total: 13 }, outputTokens: { total: 5 } },
          },
        ]), { headers: { "content-type": "text/event-stream" } });
      },
    });
    running.push({ stop: () => upstream.stop(true) });
    const proxy = startHostGatewayProxy({
      upstream_url: `http://127.0.0.1:${upstream.port}${CHAT_PATH}`,
      credential: "host-secret",
      gateway_team: "team_fixture",
      model: MODEL,
      allowed_nonces: new Set([NONCE]),
    });
    running.push(proxy);

    const response = await fetch(`${proxy.url}${CHAT_PATH}`, {
      method: "POST",
      headers: requestHeaders(),
      body: completionBody(),
    });

    expect(response.status).toBe(200);
    expect((await response.text())).toContain('"toolName":"terminal"');
    expect(authorization).toBe("Bearer host-secret");
    expect(gatewayTeam).toBe("team_fixture");
    expect(requestCount).toBe(1);
    expect(specificationVersion).toBe("4");
    expect(streaming).toBe("true");
    expect(proxy.events).toHaveLength(1);
    expect(proxy.events[0]).toMatchObject({
      layer: "host",
      outcome: "forwarded",
      upstream_status: 200,
      evidence: {
        finished: true,
        usage: { input_tokens: 13, output_tokens: 5 },
        tool_calls: [{ name: "terminal", input: { command: "bun test" } }],
      },
    });
    expect(JSON.stringify(proxy.events)).not.toContain("host-secret");
    expect(JSON.stringify(proxy.events)).not.toContain("container-dummy");
  });

  test("rejects invalid nonces, routes, and models without upstream effects", async () => {
    let requestCount = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: PROXY_IDLE_TIMEOUT_SECONDS,
      fetch() {
        requestCount += 1;
        return new Response("unexpected");
      },
    });
    running.push({ stop: () => upstream.stop(true) });
    const proxy = startHostGatewayProxy({
      upstream_url: `http://127.0.0.1:${upstream.port}${CHAT_PATH}`,
      credential: "host-secret",
      model: MODEL,
      allowed_nonces: new Set([NONCE]),
    });
    running.push(proxy);

    const invalidNonce = await fetch(`${proxy.url}${CHAT_PATH}`, {
      method: "POST",
      headers: requestHeaders("wrong"),
      body: completionBody(),
    });
    const invalidRoute = await fetch(`${proxy.url}/other`, {
      method: "POST",
      headers: requestHeaders(),
      body: completionBody(),
    });
    const invalidModel = await fetch(`${proxy.url}${CHAT_PATH}`, {
      method: "POST",
      headers: requestHeaders(),
      body: completionBody("provider/other"),
    });

    expect([invalidNonce.status, invalidRoute.status, invalidModel.status]).toEqual([
      403,
      404,
      400,
    ]);
    expect(requestCount).toBe(0);
    expect(proxy.events.every((event) => event.outcome === "rejected")).toBe(true);
  });
});

describe("relay and loopback forwarder", () => {
  test("serve the pinned catalog locally and forward chat with only a nonce", async () => {
    let upstreamAuthorization = "";
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: PROXY_IDLE_TIMEOUT_SECONDS,
      async fetch(request) {
        upstreamAuthorization = request.headers.get("authorization") ?? "";
        await request.text();
        return new Response(sse([
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "ok" },
          { type: "text-end", id: "answer" },
          { type: "finish", finishReason: { unified: "stop" }, usage: { inputTokens: { total: 2 }, outputTokens: { total: 1 } } },
        ]), { headers: { "content-type": "text/event-stream" } });
      },
    });
    running.push({ stop: () => upstream.stop(true) });
    const host = startHostGatewayProxy({
      upstream_url: `http://127.0.0.1:${upstream.port}${CHAT_PATH}`,
      credential: "host-only-token",
      model: MODEL,
      allowed_nonces: new Set([NONCE]),
    });
    running.push(host);
    const relay = startRelayProxy({
      nonce: NONCE,
      host_proxy_url: host.url,
      model: MODEL,
      hostname: "127.0.0.1",
      port: 0,
    });
    running.push(relay);
    const local = startLocalForwarder({
      nonce: NONCE,
      relay_url: relay.url,
      hostname: "127.0.0.1",
      port: 0,
    });
    running.push(local);

    const catalog = await fetch(`${local.url}${CATALOG_PATH}`);
    expect(await catalog.text()).toBe(pinnedCatalogJson(MODEL));
    expect(host.events).toHaveLength(0);

    const response = await fetch(`${local.url}${CHAT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dummy" },
      body: completionBody(),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"delta":"ok"');
    expect(upstreamAuthorization).toBe("Bearer host-only-token");
    expect(relay.events.map((event) => event.outcome)).toEqual(["catalog", "forwarded"]);
    expect(local.events.map((event) => event.outcome)).toEqual(["catalog", "forwarded"]);
    expect(host.events).toHaveLength(1);
  });
});

describe("terminal preflight gateway", () => {
  test("forces one terminal call before a final completion", async () => {
    const fake = startFakePreflightGateway({ model: MODEL, port: 0 });
    running.push(fake);

    const classifier = await fetch(`${fake.url}${CHAT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        tools: [{ name: "permission_decision" }],
      }),
    });
    expect((await classifier.text())).toContain('"toolName":"permission_decision"');

    const first = await fetch(`${fake.url}${CHAT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: completionBody(),
    });
    const second = await fetch(`${fake.url}${CHAT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "tool", content: "fx-terminal-preflight:/bin/sh\n" }],
      }),
    });
    const firstEvidence = parseGatewaySse(await first.text());
    const secondText = await second.text();

    expect(firstEvidence.tool_calls).toEqual([{
      id: "terminal_preflight_1",
      name: "terminal",
      input: {
        action: "exec",
        command: "printf 'fx-terminal-preflight:%s\\n' \"$SHELL\"",
      },
    }]);
    expect(secondText).toContain("terminal-preflight-complete");
    expect(fake.events).toHaveLength(3);
    expect(fake.events[2]?.preflight_shell).toBe("/bin/sh");
  });
});
