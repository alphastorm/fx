import { createHash } from "node:crypto";

export const VERIFICATION_REMINDER =
  "Before finalizing, verify the completed change against the user's request. " +
  "Re-read the changed contract and modified files. If correctness depends on " +
  "interacting states or events, exercise at least one combined transition. " +
  "Confirm promised effects completed rather than merely began. Fix any " +
  "discrepancy, then report concrete verification evidence.";

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sha256Text(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}
