# Exploration: post-parity-improvements

## Current State

The gateway is an OpenAI-compatible proxy over Anthropic OAuth. The transform layer (`src/transform/`) performs two-way translation. The upstream client (`src/upstream/anthropic-client.ts`) always targets `https://api.anthropic.com/v1/messages?beta=true`. The OAuth contract enforces three invariants on every upstream call: billing block at `system[0]`, `mcp_PascalCase` tool names, and a curated beta header set. The verify report for the prior change (`anthropic-api-parity-fixes`) raised two suggestions (S1: empty-string stop, S2: strict-forwarding) and flagged several items explicitly deferred for this follow-up.

---

## Item-by-item Findings

### S1 — Empty-string stop filter

**Claim**: `stop: ""` produces `stop_sequences: [""]` which Anthropic rejects with 400; the array path filters empty strings but the single-string path does not.

**Verification**: CONFIRMED. Code at `src/transform/openai-to-anthropic.ts` lines 730–738:

```ts
const normalized: string[] = typeof rawStop === "string"
  ? [rawStop]                                               // NO length guard — wraps ""
  : Array.isArray(rawStop)
    ? (rawStop as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
```

The single-string path wraps the value unconditionally. `stop: ""` → `stop_sequences: [""]`. The array path explicitly filters `s.length > 0`. The asymmetry is real and consistent with the S1 finding.

**Test coverage**: `__tests__/transform-stop-sequences.spec.ts` has four scenarios (string, array, empty array, absent) but no test for `stop: ""`.

**Fix**: Add `&& rawStop.length > 0` to the single-string branch guard before wrapping, or filter the resulting array.

**Affected spec**: `openspec/specs/transform-parity/spec.md` — Requirement "stop to stop_sequences mapping"; a new scenario must be added.

**Effort**: Low (1 line of source, 1 new test scenario).
**Recommendation**: implement.

---

### S2 — Native /v1/messages passthrough

**Claim**: Expose the Anthropic dialect so official Anthropic SDKs can point at the gateway.

**Verification — architectural conflicts**:

1. The OAuth billing contract requires `system[0]` to carry `computeBilling(firstText)` on every request. A native Anthropic SDK body already has `system[]`; injecting at index 0 would shift any client-supplied system blocks.
2. Tool names must be `mcp_PascalCase`. A native SDK client passes plain names; the gateway has no tool map for the reverse pass.
3. The beta header set is carefully curated (see `buildBetas()` in `src/upstream/headers.ts`). A native client may include beta headers the gateway explicitly excludes (e.g. `redact-thinking-2026-02-12`), creating conflicts.
4. No `/v1/messages` route is registered in `src/http/server.ts`. Adding one requires new routing + a new handler.

**Viable partial approach**: A "thin forward" handler that intercepts `POST /v1/messages`, injects the billing block into `system[0]`, remaps tool names, strips/overrides the beta header set, and forwards. This is effectively a new transform path that mirrors `openaiToAnthropic` but for Anthropic-dialect bodies instead of OpenAI bodies.

**Effort**: High. Requires a new route, a new Anthropic-to-Anthropic transform (tool name mapping, system[0] injection, beta override), new reverse transform (tool unmap), and new tests. The billing block injection for native bodies is particularly tricky because the `firstText` hash comes from the first user message's text, which may itself be structured.

**Affected specs**: None currently. Would need a new spec under `openspec/specs/`.

**Recommendation**: investigate-further. Map concrete SDK use cases first; the OAuth constraint may make this permanently impractical for clients that send `tools` and rely on round-tripping tool names.

---

### S3 — Document/PDF blocks

**Claim**: OpenAI file content parts are silently dropped; only images map to Anthropic blocks.

**Verification**: PARTIALLY CONFIRMED. The function `toAnthropicContentBlocks` at `src/transform/openai-to-anthropic.ts` lines 74–101 handles only:

- `image_url` / `input_image` → Anthropic `image` block
- `image` (already native) → pass-through
- `text` → pass-through
- any other type → **pass-through unchanged** (`out.push(block)`)

The last branch is a pass-through, NOT a silent drop. An OpenAI `{type: "file", ...}` block is forwarded as-is to Anthropic. Anthropic will then reject the request with HTTP 400 because `type: "file"` is not a recognized Anthropic content block type. The drop is effectively an upstream rejection, not a local silent discard.

**What mapping would require**: OpenAI Responses API sends file content as `{type: "input_file", file_id: "..."}` or multipart uploads. Anthropic's `document` block requires `{type: "document", source: {type: "base64", media_type: "application/pdf", data: "..."}}`. The gateway would need to either fetch the file content from OpenAI's Files API (not viable — OAuth gateway has no OpenAI credentials) or accept pre-loaded base64 from clients.

**Effort**: Medium. The content-block mapping itself is straightforward; the hard part is that OpenAI's file reference model requires a separate API call to materialize file content, which this gateway cannot make. A realistic scope is: map `{type: "input_file", file_data: {file_id: ..., content: base64}}` inline format only.

**Affected spec**: `openspec/specs/transform-parity/spec.md` — Requirement on content block types; would expand the toAnthropicContentBlocks contract.

**Recommendation**: document-as-non-goal unless there is a concrete client that sends pre-resolved file base64.

---

### S4 — Batches / Files endpoints

**Claim**: Likely not viable via OAuth (batch discount requires API billing).

**Verification — code evidence**:

- `src/config.ts`: `ANTHROPIC_API = "https://api.anthropic.com/v1/messages?beta=true"` — only one upstream endpoint.
- `src/http/server.ts`: No `/v1/batches` or `/v1/files` routes registered.
- `src/upstream/`: No client for batch or files APIs.
- `src/upstream/headers.ts`: Beta set contains `oauth-2025-04-20` — this is the OAuth flow indicator. Batch pricing is an API-key-billing feature; there is no `oauth` equivalent for the batch API.
- No evidence in any source file of batch-related endpoint calls.

**Conclusion**: No code support exists. The OAuth token used here is a Claude Max subscription token, not an API billing token. Anthropic's batch endpoint is documented as an API-key-only feature with per-token pricing. There is no observed or documented way to call `/v1/messages/batches` with an OAuth token.

**Recommendation**: document-as-non-goal. The constraint is architectural (OAuth vs. API key billing), not a code deficiency.

---

### S5 — Citations / server_tool_use response blocks

**Claim**: Response transform discards these block types; server-side tools are not requestable.

**Verification**: CONFIRMED (with nuance).

Non-streaming path (`src/transform/anthropic-to-openai.ts` lines 8–11):

```ts
const textBlock = content.find((c) => c.type === "text");
const toolBlocks = content.filter((c) => c.type === "tool_use");
const thinkingBlocks = content.filter((c) => c.type === "thinking" || c.type === "redacted_thinking");
```

Any block that is not `text`, `tool_use`, `thinking`, or `redacted_thinking` — including `server_tool_use`, `tool_result`, `document`, or `citation` — is silently ignored. The response object is assembled only from the extracted fields. No error, no client-visible signal.

Streaming path (`src/transform/streaming.ts` lines 145–189): `content_block_start` handles only `tool_use`, `thinking`, `redacted_thinking`. Unknown `cbType` values are no-ops. Deltas for unrecognized block types are silently dropped in `content_block_delta`.

**Client-visible impact today**: None, because `server_tool_use` blocks are only emitted when the client requests server-side tools (which requires a separate API contract). Citations require document source blocks (see S3 — not currently producible). The gateway cannot request server tools because they would need to be wired into the beta header set and request body.

**Recommendation**: document-as-non-goal. YAGNI confirmed — these blocks are unreachable through the current gateway. No spec change needed; the behavior is correct for the current feature surface.

---

### S6 — Deterministic tool ordering

**Claim**: Sort tools by name before transform to avoid cache prefix invalidation on unstable client ordering.

**Verification**: CONFIRMED issue is real.

At `src/transform/openai-to-anthropic.ts` lines 683–694:

```ts
if (body.tools && (body.tools as unknown[]).length > 0) {
  result.tools = (body.tools as Array<Record<string, unknown>>).map((t) => {
    const fn = t.function as Record<string, unknown>;
    return { name: mapToolName(fn.name as string, toolMap), ... };
  });
  addCacheControlToLastTool(result.tools as Array<Record<string, unknown>>);
```

Tools are mapped in client arrival order. No sort. If a client sends the same set of 20 tools in different order across requests (e.g. an IDE that builds the tool list dynamically), the upstream sees a different array order each time, which invalidates the `cache_control` breakpoint on `tools[-1]` for every non-canonical ordering.

**Complication**: The `cache_control` breakpoint is added to `tools[-1]` (the last tool after mapping). Sorting changes which tool is last. In practice, the breakpoint marks "end of tool definitions" semantically, and the cache hit is on the whole prefix up to that point — any stable ordering achieves the goal.

**One-time deploy cost**: Sorting on deploy means any request that arrives before vs. after the deploy will have a different tool order → one cache miss per in-flight session. This is acceptable.

**ToolMap impact**: The ToolMap is built during the `map()` call. The mapping itself is deterministic (fn.name → mcp_PascalCase) regardless of input order. Sorting before mapping is safe. Pre-sort (before map) is cleaner because the ToolMap `forward` key is the original client name and insertion order does not matter.

**Effort**: Low (1 sort call in `openaiToAnthropic`, 1 new test asserting stable ordering).
**Affected spec**: `openspec/specs/transform-parity/spec.md` — Extends the tools mapping requirement.
**Recommendation**: implement.

---

### S7 — Intermediate cache breakpoint

**Claim**: In agentic conversations with many tool_use/tool_result blocks, an intermediate breakpoint on a previous turn's last user block would improve cache hits.

**Verification — current breakpoint count**:

The codebase places `cache_control` in three possible locations:

1. `system[1]` — the Claude Code identity block. **Conditional** on `CLAUDE_CODE_IDENTITY=true` or `clean_system: false`. Default OFF. Uses 1 slot.
2. `tools[-1]` — last tool definition. **Present** when tools are supplied. Uses 1 slot.
3. Last user message's last block — `addCacheControlToLastUserBlock`. **Always** present (it walks backwards and places on the first `user` message found). Uses 1 slot.

The billing block at `system[0]` intentionally has **no** `cache_control` — the OAuth contract requires it to vary per request (it contains a hash of the first user message).

Maximum breakpoints in a typical agentic request with identity enabled + tools: **3** (system identity + last tool + last user block).
Maximum without identity (default): **2** (last tool + last user block).
Anthropic limit: **4** per request.

**Available budget**: 1–2 free slots.

**Why intermediate breakpoints help**: In multi-turn agentic flows, the conversation accumulates many `user` messages (each tool_result batch is a user message). Anthropic's cache prefix matching is a prefix-only check. The `cache_control` on the last user block anchors the cache prefix to the most recent turn. Earlier turns are NOT cached individually. If the previous turn's user message had a `cache_control` breakpoint in the prior request, Anthropic will try to match that cached prefix for the next request — but only up to the 4-breakpoint total and only within the last 20 content blocks (Anthropic's sliding window).

**Design challenge**: The current `addCacheControlToLastUserBlock` only marks the last user message. Adding an intermediate breakpoint would require tracking the "second-to-last" user message and placing a breakpoint there. Complications:

1. The "second-to-last" user message in the conversation context is the most recent one from the prior request. Its position changes every turn.
2. Adding a 2nd user-message breakpoint consumes one more slot, leaving only 0–1 free if identity is active.

**Constraint preservation**: The billing block (system[0]) must NOT receive cache_control. This constraint is already upheld and must not be disturbed.

**Effort**: Medium. The function `addCacheControlToLastUserBlock` must be extended to also mark an earlier user message. The exact strategy (mark N-1, or mark the turn boundary deterministically) requires careful design to avoid consuming all 4 slots.

**Affected spec**: `openspec/specs/transform-parity/spec.md` or a new `openspec/specs/cache-strategy/spec.md`.
**Recommendation**: investigate-further. The gain depends on conversation length and whether Anthropic's 20-block lookback is actually a binding constraint for typical agentic workloads.

---

## Affected openspec/specs Files per Item

| Item | Affected Spec | Action |
|------|--------------|--------|
| S1 — Empty-string stop | `openspec/specs/transform-parity/spec.md` | Add scenario: `stop: ""` omits `stop_sequences` |
| S2 — Native passthrough | None (no spec exists) | New spec if implemented |
| S3 — Document/PDF blocks | `openspec/specs/transform-parity/spec.md` | Add content-block mapping scenarios if implemented |
| S4 — Batches/Files | None | No action; document-as-non-goal |
| S5 — Citations/server_tool_use | None | No action; YAGNI confirmed |
| S6 — Tool ordering | `openspec/specs/transform-parity/spec.md` | Add stable tool ordering requirement |
| S7 — Intermediate cache breakpoint | `openspec/specs/transform-parity/spec.md` or new `cache-strategy` spec | Depends on proposal outcome |

---

## Approach Comparison Table

| Item | Approach | Pros | Cons | Effort | Recommendation |
|------|----------|------|------|--------|---------------|
| S1 Stop filter | Add `rawStop.length > 0` guard | 1 line, zero risk | None | Low | implement |
| S2 Native passthrough | New `/v1/messages` handler with thin forward | Enables Anthropic SDK clients | Breaks OAuth billing unless billing block is injected; tool unmap complexity | High | investigate-further |
| S3 Document/PDF | Map pre-resolved base64 file content to Anthropic `document` | Enables PDF-aware clients | Cannot materialize file references; limited client support | Medium | document-as-non-goal |
| S4 Batches/Files | Add batch endpoints | Enables async workloads | OAuth token has no batch billing; non-viable | High, non-viable | document-as-non-goal |
| S5 Citations/server_tool_use | Emit unknown blocks as opaque extension fields | Defensive future-proofing | YAGNI; no client reaches these blocks today | Low | document-as-non-goal |
| S6 Tool ordering | `body.tools.sort()` before map | Stable cache prefix; 1-line fix | One-time cache invalidation on deploy | Low | implement |
| S7 Intermediate cache breakpoint | Add second `cache_control` to previous turn's last user block | Better cache hit rates in long agentic conversations | Consumes budget slot; complex turn-boundary detection | Medium | investigate-further |

---

## Ready for Proposal

Yes, for items S1 and S6 (implement). Items S2, S3, S4, S5, S7 have clear enough findings to propose scoped decisions (two as document-as-non-goal, two as investigate-further).

The proposal phase should define which of the seven items to include in scope for this change and which to close as non-goals. S1 + S6 are ready for immediate implementation work. S7 may warrant a separate investigation SDD if cache hit profiling data becomes available.
