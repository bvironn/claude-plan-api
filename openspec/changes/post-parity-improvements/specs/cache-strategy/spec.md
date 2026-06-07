# Cache Strategy Specification

## Purpose

Defines the breakpoint placement policy for Anthropic `cache_control` markers within a gateway request. Controls which content positions receive breakpoints, how the four-slot budget is allocated across identity, tools, and user-message positions, and which positions are permanently excluded from breakpoint placement.

---

## Requirements

### Requirement: billing block exclusion invariant

The `system[0]` block (the OAuth billing block) MUST NEVER carry `cache_control`, regardless of slot availability or any other condition. This invariant MUST hold even when the total breakpoint count is below the four-slot limit.

#### Scenario: billing block has no cache_control with slots available

- GIVEN a request where the slot budget is not exhausted and all other breakpoints are placed normally
- WHEN the breakpoint planner runs
- THEN `system[0]` does NOT contain a `cache_control` field

#### Scenario: billing block has no cache_control when identity block is absent

- GIVEN a request with `CLAUDE_CODE_IDENTITY=false` (clean system) so the identity block at `system[1]` is absent
- WHEN the breakpoint planner runs
- THEN `system[0]` still does NOT contain a `cache_control` field

---

### Requirement: total breakpoint count does not exceed four

The total number of `cache_control` markers placed across all positions (identity block, last tool, last user-message block, intermediate user-message block) MUST NOT exceed four per request. The planner MUST account for all active slots before placing any new breakpoint.

Slot allocation (worst case with all positions active):
- Slot 1: identity block at `system[1]` — present only when `CLAUDE_CODE_IDENTITY=true`
- Slot 2: last tool definition (`tools[-1]`) — present only when tools are supplied
- Slot 3: last user message's last content block
- Slot 4: second-to-last user message's last content block (intermediate)

#### Scenario: four breakpoints placed when all positions are active

- GIVEN a request with identity enabled, tools present, and three or more user messages
- WHEN the breakpoint planner runs
- THEN exactly four `cache_control` markers are present across the upstream body
- AND no single content block carries more than one `cache_control`

#### Scenario: two breakpoints placed when identity is off and no tools

- GIVEN a request with `CLAUDE_CODE_IDENTITY=false`, no tools, and three or more user messages
- WHEN the breakpoint planner runs
- THEN exactly two `cache_control` markers are present (last user block and intermediate user block)

---

### Requirement: intermediate user-message breakpoint placement

When a conversation contains two or more user messages, the planner MUST place a `cache_control` breakpoint on the last content block of the second-to-last user message (the user message immediately preceding the most recent one). This intermediate breakpoint improves cache-prefix reuse in agentic multi-turn conversations by anchoring Anthropic's prefix check to a stable prior turn boundary.

#### Scenario: intermediate breakpoint placed on second-to-last user message

- GIVEN a conversation with exactly two user messages, tools present, identity off
- WHEN the breakpoint planner runs
- THEN the last content block of the first user message carries `cache_control`
- AND the last content block of the second (most recent) user message carries `cache_control`

#### Scenario: intermediate breakpoint placed when three or more user messages exist

- GIVEN a conversation with four user messages
- WHEN the breakpoint planner runs
- THEN the last content block of the third user message carries `cache_control` (second-to-last)
- AND the last content block of the fourth user message carries `cache_control` (last)

---

### Requirement: skip intermediate breakpoint for conversations with fewer than two user messages

When the conversation contains fewer than two user messages, the planner MUST NOT place an intermediate user-message breakpoint. Only the final user-message breakpoint (and, when active, the identity and tools slots) MUST be placed.

#### Scenario: single user message — no intermediate breakpoint

- GIVEN a conversation with exactly one user message
- WHEN the breakpoint planner runs
- THEN only the last user message's last content block carries a user-message `cache_control`
- AND no other user message block carries `cache_control`

#### Scenario: zero user messages — no user-message breakpoints

- GIVEN a conversation with no user messages (system-only or empty body)
- WHEN the breakpoint planner runs
- THEN no user-message block carries `cache_control`

---

### Requirement: intermediate breakpoint is dropped first when slot budget is full

When the four-slot budget is already consumed by identity, tools, and the final user-message breakpoint, the intermediate user-message breakpoint MUST be omitted rather than displacing any other active slot. The intermediate breakpoint has the lowest eviction priority among all four slots.

**Structural invariant**: With the current slot allocation formula (`budget = 4 − identity − tools`), the minimum user-message budget is 2 (when both identity and tools are active: `4 − 1 − 1 = 2`). The planner places intermediate only when `budget ≥ 2`, so intermediate is always placed when two or more user messages exist under any reachable public-API input. The eviction priority is enforced structurally by the `budget ≥ 2` guard in `applyCacheBreakpoints`, not by runtime eviction of a competing slot. Unit tests for this requirement use the `budget` parameter directly rather than end-to-end invocation, because no public-API input can drive the guard below 2.

The skip rule (fewer than two user messages) is the observable runtime path where intermediate is absent: with only one user message, there is no second-to-last message to anchor the intermediate breakpoint, so it is naturally absent regardless of budget.

#### Scenario: intermediate breakpoint absent when only one user message exists (skip rule, not eviction)

- GIVEN a request with identity enabled (slot 1) and tools present (slot 2), and only one user message
- WHEN the breakpoint planner runs
- THEN the total `cache_control` count is three (identity + last tool + final user)
- AND no intermediate user-message breakpoint is placed (no second-to-last message exists)

#### Scenario: intermediate breakpoint placed when one user slot remains (budget ≥ 2 guard)

- GIVEN a request with identity enabled (slot 1) and tools present (slot 2), leaving two slots for user messages
- WHEN the breakpoint planner runs against a conversation with two or more user messages
- THEN both the intermediate and final user-message blocks carry `cache_control`
- AND the total count is four
