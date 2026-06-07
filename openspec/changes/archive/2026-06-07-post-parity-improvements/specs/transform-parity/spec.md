# Delta for Transform Parity

## MODIFIED Requirements

### Requirement: stop to stop_sequences mapping

The transform MUST copy the OpenAI `stop` field to the Anthropic `stop_sequences` array. A string value MUST be wrapped in a single-element array, but ONLY when the string is non-empty; an empty string `""` MUST be treated identically to an absent `stop` value and MUST result in `stop_sequences` being omitted. An array value MUST be forwarded after filtering out any empty-string elements; an array that is empty or becomes empty after filtering MUST result in `stop_sequences` being omitted. Absent or undefined `stop` MUST also result in `stop_sequences` being omitted.

(Previously: the single-string path wrapped the value unconditionally, so `stop: ""` produced `stop_sequences: [""]` which Anthropic rejects with HTTP 400; the array path already filtered empty strings — this requirement aligns both paths.)

#### Scenario: string stop becomes single-element array

- GIVEN a request with `stop: "\n"`
- WHEN `openaiToAnthropic` runs
- THEN the resulting body contains `stop_sequences: ["\n"]`

#### Scenario: string array stop forwarded as-is

- GIVEN a request with `stop: ["STOP", "END"]`
- WHEN `openaiToAnthropic` runs
- THEN the resulting body contains `stop_sequences: ["STOP","END"]`

#### Scenario: empty array omits stop_sequences

- GIVEN a request with `stop: []`
- WHEN `openaiToAnthropic` runs
- THEN the resulting body does NOT contain a `stop_sequences` key

#### Scenario: absent stop omits stop_sequences

- GIVEN a request with no `stop` field
- WHEN `openaiToAnthropic` runs
- THEN the resulting body does NOT contain a `stop_sequences` key

#### Scenario: empty string stop omits stop_sequences

- GIVEN a request with `stop: ""`
- WHEN `openaiToAnthropic` runs
- THEN the resulting body does NOT contain a `stop_sequences` key

#### Scenario: array containing only empty strings omits stop_sequences

- GIVEN a request with `stop: ["", ""]`
- WHEN `openaiToAnthropic` runs
- THEN the resulting body does NOT contain a `stop_sequences` key

---

## ADDED Requirements

### Requirement: deterministic tool ordering before mapping

Before mapping OpenAI tool definitions to Anthropic format, the transform MUST sort the tool array in ascending lexicographic order by the original client-supplied `function.name`. The sort MUST be applied before the ToolMap is constructed and before `cache_control` is placed on the last tool. Identical tool sets sent in any arrival order MUST produce a byte-identical upstream `tools` array, ensuring that the cache prefix anchored at `tools[-1]` is stable across requests.

#### Scenario: tools in non-alphabetical order are sorted before mapping

- GIVEN a request with `tools` in order `["search", "calculator", "fetch"]`
- WHEN `openaiToAnthropic` runs
- THEN the upstream body's `tools` array is ordered `["calculator", "fetch", "search"]` (ascending by client name, post-mapped to `mcp_PascalCase`)

#### Scenario: same tool set in different arrival orders produces identical upstream arrays

- GIVEN two requests carrying the same tool set in different orders — request A with `["b_tool", "a_tool"]` and request B with `["a_tool", "b_tool"]`
- WHEN `openaiToAnthropic` runs on each
- THEN both produce an upstream `tools` array in the same order with the same `cache_control` on the same last element

#### Scenario: cache_control lands on last tool after sort

- GIVEN a request with tools `["z_tool", "a_tool"]`
- WHEN `openaiToAnthropic` runs
- THEN `cache_control` is attached to the tool whose client name is `"z_tool"` (the last in sorted order)
- AND no other tool carries `cache_control`

#### Scenario: single tool is unaffected by sort

- GIVEN a request with exactly one tool
- WHEN `openaiToAnthropic` runs
- THEN the upstream body contains that tool with `cache_control` and no sort-related side effects
