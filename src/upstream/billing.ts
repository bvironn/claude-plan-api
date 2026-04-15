import { createHash } from "node:crypto";
import { SALT, VERSION } from "../config.ts";

export function computeBilling(firstUserMessage: string): string {
  const msg = firstUserMessage || "";
  const cch = createHash("sha256").update(msg).digest("hex").slice(0, 5);
  const sampled = [4, 7, 20].map((i) => (i < msg.length ? msg[i] : "0")).join("");
  const suffix = createHash("sha256").update(`${SALT}${sampled}${VERSION}`).digest("hex").slice(0, 3);
  return `x-anthropic-billing-header: cc_version=${VERSION}.${suffix}; cc_entrypoint=cli; cch=${cch};`;
}
