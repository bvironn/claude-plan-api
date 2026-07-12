import { describe, it, expect } from "bun:test";
import { firstUserPreview } from "../src/observability/conversation-preview.ts";
import { groupIntoConversations } from "../src/ui/src/lib/sessions.ts";
import type { RequestRecord } from "../src/ui/src/lib/types.ts";

/**
 * Grouping parity (spec `telemetry-list-projection`, task 1.10).
 *
 * The slim projection drops the request/upstream body fields and instead ships
 * a server-derived `firstUserPreview`. Session grouping MUST be identical on the
 * slim shape and the full (body-carrying) shape — the whole point of shipping
 * the preview. This test builds full fixtures with known grouping, derives the
 * slim shape the way the backend does (`firstUserPreview` from the body, bodies
 * dropped), and asserts `groupIntoConversations` yields identical conversation
 * ids and turn counts on both.
 */

let seq = 0;
function fullRow(over: Partial<RequestRecord> & { traceId: string; timestamp: string }): RequestRecord {
  return {
    id: ++seq,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    duration: 10,
    model: "claude-x",
    isStream: false,
    requestBody: null,
    responseBody: null,
    upstreamRequestBody: null,
    error: null,
    ...over,
  };
}

function chatBody(text: string): string {
  return JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: text }] });
}

/** Mirror the backend slim projection: preview from bodies, bodies dropped. */
function toSlim(full: RequestRecord): RequestRecord {
  return {
    ...full,
    firstUserPreview:
      firstUserPreview(full.upstreamRequestBody) ?? firstUserPreview(full.requestBody),
    requestBody: undefined,
    responseBody: undefined,
    upstreamRequestBody: undefined,
  };
}

// A long forwarded-context preamble + short question, to exercise the
// splitContextPreamble path identically on both shapes.
const PREAMBLE = "SYSTEM CONTEXT ".concat("z".repeat(700));
const QUESTION_C = "So what is the time complexity here?";

// Known grouping:
//   A: two turns, same first-user text, ~1 min apart → ONE conversation (2 turns)
//   B: one turn, different first-user text            → a second conversation
//   C: one turn, long preamble + short question       → a third conversation
const FULL: RequestRecord[] = [
  fullRow({
    traceId: "a1",
    timestamp: "2026-01-01T10:00:00.000Z",
    upstreamRequestBody: chatBody("Explain closures in JavaScript"),
  }),
  fullRow({
    traceId: "a2",
    timestamp: "2026-01-01T10:01:00.000Z",
    upstreamRequestBody: chatBody("Explain closures in JavaScript"),
  }),
  fullRow({
    traceId: "b1",
    timestamp: "2026-01-01T10:02:00.000Z",
    upstreamRequestBody: chatBody("Explain promises in JavaScript"),
  }),
  fullRow({
    traceId: "c1",
    timestamp: "2026-01-01T10:03:00.000Z",
    upstreamRequestBody: chatBody(`${PREAMBLE}\n\n${QUESTION_C}`),
  }),
];

describe("session grouping parity — slim vs full", () => {
  it("produces the same conversation ids on the slim shape as on the full shape", () => {
    const fullGroups = groupIntoConversations(FULL);
    const slimGroups = groupIntoConversations(FULL.map(toSlim));

    // Sanity: the fixtures actually group into three conversations (non-trivial).
    expect(fullGroups.length).toBe(3);

    const fullIds = fullGroups.map((c) => c.id).sort();
    const slimIds = slimGroups.map((c) => c.id).sort();
    expect(slimIds).toEqual(fullIds);
  });

  it("produces the same turn counts per conversation (A collapses two turns)", () => {
    const byId = (groups: ReturnType<typeof groupIntoConversations>) =>
      Object.fromEntries(groups.map((c) => [c.id, c.turns]));

    const fullTurns = byId(groupIntoConversations(FULL));
    const slimTurns = byId(groupIntoConversations(FULL.map(toSlim)));

    expect(slimTurns).toEqual(fullTurns);
    // The two-turn conversation is present with turns === 2.
    expect(Math.max(...Object.values(fullTurns))).toBe(2);
  });

  it("still groups the long-preamble conversation identically (preamble split parity)", () => {
    // The slim preview for C is the post-preamble question; grouping must land
    // it in the same conversation id as the full body parse.
    const slim = FULL.map(toSlim);
    const cSlim = slim.find((r) => r.traceId === "c1")!;
    expect(cSlim.firstUserPreview).toBe(QUESTION_C);

    const fullC = groupIntoConversations(FULL).find((c) => c.traceIds.includes("c1"))!;
    const slimC = groupIntoConversations(slim).find((c) => c.traceIds.includes("c1"))!;
    expect(slimC.id).toBe(fullC.id);
  });
});
