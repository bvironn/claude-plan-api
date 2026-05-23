import { createHash } from "node:crypto";
import { SALT, VERSION } from "../config.ts";

export function computeBilling(firstUserMessage: string): string {
  const msg = firstUserMessage || "";
  const cch = createHash("sha256").update(msg).digest("hex").slice(0, 5);
  const sampled = [4, 7, 20].map((i) => (i < msg.length ? msg[i] : "0")).join("");
  const suffix = createHash("sha256").update(`${SALT}${sampled}${VERSION}`).digest("hex").slice(0, 3);
  // `cc_entrypoint` must match the entrypoint label in the user-agent.
  // Claude Code 2.1.112 reports `sdk-cli`; the billing header has to track
  // the same value or Anthropic flags the request as mismatched fingerprint.
  // Mirrors opencode-claude-auth PR #207.
  return `x-anthropic-billing-header: cc_version=${VERSION}.${suffix}; cc_entrypoint=sdk-cli; cch=${cch};`;
}
