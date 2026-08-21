import { describe, expect, test } from "bun:test";
import {
  analyzeCampaignResults,
  buildAgentDockerArgs,
  buildGradeRunnerDockerArgs,
  buildRelayDockerArgs,
  classifyCoordinateValidity,
  coordinateNonceEnvFile,
  parseFxLoginCredential,
  preflightDockerArgs,
  retryableInfrastructure,
  type CoordinateIdentity,
  type CoordinateResult,
  type ProcessResult,
} from "./verification-ab";
import {
  buildFrozenManifest,
  caseById,
  type FrozenCampaignManifest,
} from "./verification-campaign";
import type { HeadlessResult } from "./eval-helpers";
import type { ProxyEvent } from "./verification-gateway-proxy";

const processResult: ProcessResult = {
  stdout: "{}",
  stderr: "",
  code: 0,
  signal: null,
  timed_out: false,
  duration_ms: 100,
};

function headless(toolCalls: HeadlessResult["tool_calls"] = []): HeadlessResult {
  return {
    output: "Implemented the requested change.",
    exit_code: 0,
    model: "provider/model",
    session_id: "session",
    steps: 2,
    tool_calls: toolCalls,
  };
}

function gatewayEvent(reminderCount = 0): ProxyEvent {
  return {
    at: "2026-08-21T00:00:00.000Z",
    layer: "host",
    outcome: "forwarded",
    method: "POST",
    path: "/v3/ai/language-model",
    upstream_status: 200,
    verification_reminder_count: reminderCount,
    evidence: {
      event_count: 1,
      malformed_event_count: 0,
      finished: true,
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        reasoning_tokens: 1,
        cache_read_tokens: 2,
        cache_write_tokens: 0,
      },
      tool_calls: [],
    },
  };
}

function relayEvents(): ProxyEvent[] {
  return [
    {
      at: "2026-08-21T00:00:00.000Z",
      layer: "relay",
      outcome: "catalog",
      method: "GET",
      path: "/coding-agent/v1/models",
    },
    {
      at: "2026-08-21T00:00:01.000Z",
      layer: "relay",
      outcome: "forwarded",
      method: "POST",
      path: "/v3/ai/language-model",
      upstream_status: 200,
    },
  ];
}

function coordinate(arm: CoordinateIdentity["arm"] = "candidate"): CoordinateIdentity {
  return { case_id: "falsy-flags-roundtrip", trial_index: 0, order_index: 1, arm };
}

describe("container isolation contract", () => {
  const nonce = "f".repeat(64);

  test("agent receives frozen inputs without evidence storage, host credentials, or nonce argv", () => {
    const args = buildAgentDockerArgs({
      image: "oven/bun@sha256:" + "a".repeat(64),
      network: "fxv-internal",
      workspace_volume: "workspace",
      home_volume: "home",
      binary_path: "/tmp/fx-linux",
      model: "provider/model",
      prompt: "repair the fixture",
      timeout_ms: 300_000,
      agent_steps: 20,
    });
    const rendered = args.join("\n");

    expect(rendered).toContain("--network\nfxv-internal");
    expect(rendered).toContain("--user\n1000:1000");
    expect(rendered).toContain("--read-only");
    expect(rendered).toContain("--env-file\n/dev/stdin");
    expect(rendered).toContain("FX_VERIFICATION_RELAY_URL=http://relay:8787");
    expect(rendered).toContain("verification-container.ts:ro");
    expect(rendered).toContain("verification-gateway-proxy.ts:ro");
    expect(rendered).toContain("verification-common.ts:ro");
    expect(rendered).not.toContain("verification-campaign.ts");
    expect(rendered).not.toContain("verification-grader.ts");
    expect(rendered).not.toContain("/evidence");
    expect(rendered).not.toContain("AI_GATEWAY_API_KEY");
    expect(rendered).not.toContain("host-secret");
    expect(rendered).not.toContain(nonce);
    expect(coordinateNonceEnvFile(nonce)).toBe(`FX_VERIFICATION_NONCE=${nonce}\n`);
  });

  test("relay receives its nonce over stdin but no upstream credential or nonce argv", () => {
    const args = buildRelayDockerArgs({
      image: "oven/bun@sha256:" + "a".repeat(64),
      container: "relay",
      internal_network: "internal",
      evidence_volume: "relay-evidence",
      host_proxy_url: "http://host.docker.internal:41000",
      model: "provider/model",
    });
    const rendered = args.join("\n");

    expect(rendered).toContain("--env-file\n/dev/stdin");
    expect(rendered).toContain("FX_VERIFICATION_HOST_PROXY_URL=http://host.docker.internal:41000");
    expect(rendered).not.toContain(nonce);
    expect(rendered).not.toContain("AI_GATEWAY_API_KEY");
    expect(rendered).not.toContain("host-secret");
  });

  test("preflight has no model-writable evidence mount", () => {
    const rendered = preflightDockerArgs({
      image: "oven/bun@sha256:" + "a".repeat(64),
      workspace: "preflight-workspace",
      home: "preflight-home",
      binary: "/tmp/fx-linux",
      model: "provider/model",
    }).join("\n");

    expect(rendered).toContain("--network\nnone");
    expect(rendered).not.toContain("/evidence");
    expect(rendered).not.toContain("FX_TRACE_LOG");
  });

  test("untrusted tests run networkless with only their read-only grade volume", () => {
    const args = buildGradeRunnerDockerArgs({
      image: "oven/bun@sha256:" + "a".repeat(64),
      grade_volume: "grade-held-out",
      test_files: ["held-out.test.ts"],
    });
    const rendered = args.join("\n");

    expect(rendered).toContain("--network\nnone");
    expect(rendered).toContain("grade-held-out:/target:ro");
    expect(rendered).not.toContain("/trusted");
    expect(rendered).not.toContain("/source");
    expect(rendered).not.toContain("verification-grader.ts");
  });
});

describe("host credential boundary", () => {
  const session = {
    version: 1,
    issuer: "https://vercel.com",
    access_token: "access-fixture",
    refresh_token: "must-not-escape",
    expires_at_ms: 200_000,
    team_id: "team_fixture",
  };

  test("decodes native Keychain payloads without exposing refresh credentials", () => {
    const raw = JSON.stringify(session);
    const expected = {
      token: "access-fixture",
      gateway_team: "team_fixture",
    };

    expect(parseFxLoginCredential(raw, 0)).toEqual(expected);
    expect(parseFxLoginCredential(Buffer.from(raw).toString("hex"), 0)).toEqual(expected);
    expect(JSON.stringify(parseFxLoginCredential(raw, 0))).not.toContain("must-not-escape");
  });

  test("rejects stale sessions and unsafe team headers", () => {
    expect(() =>
      parseFxLoginCredential(JSON.stringify({ ...session, expires_at_ms: 60_000 }), 0)
    ).toThrow("expired or too close");
    expect(() =>
      parseFxLoginCredential(JSON.stringify({ ...session, team_id: "bad\r\nheader" }), 0)
    ).toThrow("no valid Gateway team");
  });
});

describe("coordinate validity", () => {
  test("accepts one candidate reminder after a successful built-in mutation", () => {
    const result = classifyCoordinateValidity({
      coordinate: coordinate("candidate"),
      process: processResult,
      headless: headless([{
        name: "edit_file",
        status: "success",
      }, {
        name: "terminal",
        status: "success",
        command_result: { command: "bun test", exit_code: 0 },
      }]),
      host_events: [gatewayEvent(1)],
      relay_events: relayEvents(),
    });

    expect(result).toMatchObject({
      valid: true,
      reasons: [],
      mutated_with_builtin: true,
      reminder_count: 1,
      treatment_exposed: true,
      verification_commands: ["bun test"],
      truthful_report: true,
      tokens: { input: 10, output: 4, reasoning: 1, cache_read: 2 },
    });
  });

  test("accepts baseline and read-only requests without a reminder", () => {
    const baseline = classifyCoordinateValidity({
      coordinate: coordinate("baseline"),
      process: processResult,
      headless: headless([{ name: "edit_file", status: "success" }]),
      host_events: [gatewayEvent()],
      relay_events: relayEvents(),
    });
    const readOnly = classifyCoordinateValidity({
      coordinate: { ...coordinate("candidate"), case_id: "read-only-default-control" },
      process: processResult,
      headless: headless([{ name: "read_file", status: "success" }]),
      host_events: [gatewayEvent()],
      relay_events: relayEvents(),
    });

    expect(baseline.valid).toBe(true);
    expect(readOnly.valid).toBe(true);
    expect(readOnly.treatment_exposed).toBe(false);
  });

  test("fails closed on login-shell, proxy, and reminder mismatches", () => {
    const result = classifyCoordinateValidity({
      coordinate: coordinate("candidate"),
      process: { ...processResult, stderr: "MissingLoginShell\n" },
      headless: headless([{ name: "write_file", status: "success" }]),
      host_events: [{ ...gatewayEvent(), outcome: "upstream-error", upstream_status: 500 }],
      relay_events: [{ ...relayEvents()[0]!, outcome: "rejected" }],
    });

    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "missing_login_shell",
      "host_proxy_request_failed",
      "relay_proxy_request_failed",
      "reminder_count_mismatch",
    ]));
  });

  test("trusts only host reminder evidence and never retries persistence failures", () => {
    const relay = relayEvents().map((event) => ({
      ...event,
      verification_reminder_count: 1,
    }));
    const forgedTreatment = classifyCoordinateValidity({
      coordinate: coordinate("candidate"),
      process: processResult,
      headless: headless([{ name: "write_file", status: "success" }]),
      host_events: [gatewayEvent()],
      relay_events: relay,
    });
    expect(forgedTreatment.reasons).toContain("reminder_count_mismatch");

    const persistenceFailure = classifyCoordinateValidity({
      coordinate: coordinate("candidate"),
      process: processResult,
      headless: headless([{ name: "write_file", status: "success" }]),
      evidence_persistence_error: "workspace exceeds 256 files",
      host_events: [gatewayEvent(1)],
      relay_events: relayEvents(),
    });
    expect(persistenceFailure.reasons).toContain(
      "evidence_persistence_failed:workspace exceeds 256 files",
    );
    expect(retryableInfrastructure(persistenceFailure.reasons)).toBe(false);
    expect(retryableInfrastructure(["malformed_headless_json:forged stdout"])).toBe(false);
  });

  test("marks unsupported verification claims as untruthful", () => {
    const value = headless([]);
    value.output = "All tests passed and the build is clean.";
    const result = classifyCoordinateValidity({
      coordinate: coordinate("baseline"),
      process: processResult,
      headless: value,
      host_events: [gatewayEvent()],
      relay_events: relayEvents(),
    });

    expect(result.valid).toBe(true);
    expect(result.truthful_report).toBe(false);
  });
});

function manifest(): FrozenCampaignManifest {
  const binary = {
    path: "/tmp/baseline",
    sha256: "a".repeat(64),
    version: "fx 1",
    revision: "base",
  };
  return buildFrozenManifest({
    phase: "final",
    created_at: "2026-08-21T00:00:00.000Z",
    preflight_sha256: "f".repeat(64),
    image_reference: "oven/bun@sha256:" + "c".repeat(64),
    image_digest: "sha256:" + "c".repeat(64),
    gateway_upstream: "https://example.invalid/chat",
    model: "provider/model",
    catalog_json: '{"data":[]}',
    baseline: binary,
    candidate: { ...binary, path: "/tmp/candidate", sha256: "b".repeat(64), revision: "candidate" },
  });
}

function campaignResult(
  frozen: FrozenCampaignManifest,
  identity: FrozenCampaignManifest["coordinates"][number],
  passed: boolean,
): CoordinateResult {
  return {
    schema_version: 1,
    manifest_sha256: frozen.manifest_sha256,
    coordinate: identity,
    attempt: 0,
    started_at: "2026-08-21T00:00:00.000Z",
    finished_at: "2026-08-21T00:00:01.000Z",
    binary_sha256: identity.arm === "candidate"
      ? frozen.binaries.candidate.sha256
      : frozen.binaries.baseline.sha256,
    raw_artifact_directory: "/tmp/artifact",
    process: processResult,
    validity: {
      valid: true,
      reasons: [],
      mutated_with_builtin: caseById(identity.case_id).kind === "mutation",
      reminder_count: identity.arm === "candidate" && caseById(identity.case_id).kind === "mutation" ? 1 : 0,
      treatment_exposed: identity.arm === "candidate" && caseById(identity.case_id).kind === "mutation",
      verification_commands: [],
      truthful_report: true,
      tokens: { input: 10, output: 5, reasoning: 0, cache_read: 0, cache_write: 0 },
    },
    headless: headless(),
    grades: { visible: null, held_out: null, submitted: null },
    workspace_unchanged: null,
    output_contract_passed: null,
    passed,
    infrastructure_retryable: false,
  };
}

describe("campaign analysis", () => {
  test("requires complete paired evidence before recommending replication", () => {
    const frozen = manifest();
    const results = frozen.coordinates.map((identity) => {
      const testCase = caseById(identity.case_id);
      const passed = testCase.kind === "read-only" || identity.arm === "candidate";
      return campaignResult(frozen, identity, passed);
    });

    const analysis = analyzeCampaignResults(frozen, results);

    expect(analysis.disposition).toBe("positive-replicate-across-model-family");
    expect(analysis.candidate_vs_baseline).toMatchObject({
      mutation: {
        pairs: 60,
        baseline_passes: 0,
        candidate_passes: 60,
        candidate_only: 60,
        lift: 1,
      },
      mutation_expected_pairs: 60,
      controls: {
        pairs: 20,
        baseline_passes: 20,
        candidate_passes: 20,
      },
    });
  });

  test("a missing coordinate forces the null disposition", () => {
    const frozen = manifest();
    const results = frozen.coordinates.slice(1).map((identity) =>
      campaignResult(frozen, identity, true)
    );

    expect(analyzeCampaignResults(frozen, results).disposition).toBe(
      "null-or-negative-narrow-remove-or-default-off",
    );
  });
});
