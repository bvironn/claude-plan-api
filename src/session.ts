import { createHash } from "node:crypto";

export const SESSION_ID = crypto.randomUUID();
export const DEVICE_ID = createHash("sha256").update(`gateway-${SESSION_ID}`).digest("hex");
