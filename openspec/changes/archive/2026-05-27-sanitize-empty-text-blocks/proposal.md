# Proposal: Sanitize Empty Text Blocks in OpenAI→Anthropic Transform

## Intent

Anthropic rejects requests containing empty text content blocks or whitespace-only string content with HTTP 400 (`messages: text content blocks must be non-empty`). OpenAI-SDK clients (Continue.dev via `OpenAI/JS 5.23.2`) routinely emit such payloads — empty placeholder text blocks before `tool_calls`, whitespace-only user messages on regenerate, and occasional empty user strings. Live telemetry shows 2/3 chat requests failing with this exact error in a single session. The transform must sanitize these payloads before forwarding to Anthropic.

## Scope

### In Scope
- Filter empty/whitespace-only text content blocks from assistant and user `content[]` arrays
- Replace whitespace-only string user content with `"(empty)"` placeholder to preserve turn structure (Continue's regenerate semantic)
- Replace empty string user content with `"(empty)"` placeholder
- Drop assistant messages whose `content[]` becomes empty after filtering AND have no `tool_calls`
- Preserve assistant messages with `tool_calls` even when text content is fully filtered
- Adversarial test suite covering Continue.dev payload shapes

### Out of Scope
- Sanitizing image/document content blocks (not the failure mode)
- Anthropic→OpenAI reverse transform (no equivalent failure observed)
- Streaming transform changes (failure happens at request-build time, not response)
- Telemetry/observability changes (existing logging already captured the bug)

## Capabilities

### New Capabilities
- `transform-sanitization`: Rules for sanitizing OpenAI-format chat payloads before they enter the Anthropic transform — empty content handling, placeholder policy, message-drop policy.

### Modified Capabilities
- None.

## Approach

Add a `sanitizeOpenAIMessages()` step at the entry of `openaiToAnthropic()` in `src/transform/openai-to-anthropic.ts`. The function walks each message and applies:

1. **Array content**: filter `type === "text"` blocks where `text.trim() === ""`. If the resulting array is empty AND the message has no `tool_calls`, drop the message.
2. **String content (user)**: if `content.trim() === ""`, replace with `"(empty)"`.
3. **String content (assistant)**: if empty/whitespace-only AND no `tool_calls`, drop the message.

Keep the function pure (input → new array) so it is trivially unit-testable. Run before the existing role/tool transformation logic — sanitization is an upstream concern.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/transform/openai-to-anthropic.ts` | Modified | Add `sanitizeOpenAIMessages()` and call it at entry (~30 LOC) |
| `__tests__/transform-sanitize-empty-blocks.spec.ts` | New | Adversarial tests for Continue.dev shapes (~150 LOC) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Dropping a message changes conversation turn count and confuses upstream | Low | Only drop when message has no `tool_calls` AND content is fully empty; prefer placeholder for trailing user turns |
| Placeholder `"(empty)"` leaks into model context as visible noise | Low | Use for whitespace-only user content only; document in spec; revisit if model behavior degrades |
| Sanitization masks a real client bug we should report upstream | Medium | Log a single warn-level event when sanitization mutates a payload, with client `user-agent` |

## Rollback Plan

Revert the commit touching `src/transform/openai-to-anthropic.ts` and delete `__tests__/transform-sanitize-empty-blocks.spec.ts`. No data migration, no config, no schema change — pure code revert. `bun test` confirms baseline restored.

## Dependencies

- None. Pure TypeScript change inside existing transform module. No new packages.

## Success Criteria

- [ ] `bun test` passes including new adversarial suite
- [ ] Continue.dev requests previously failing with `text content blocks must be non-empty` succeed end-to-end
- [ ] No regression in existing `openai-to-anthropic` tests
- [ ] `bun run tsc --noEmit` clean
