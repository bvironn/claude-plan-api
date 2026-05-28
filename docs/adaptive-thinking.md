# Adaptive thinking — the long version

The short version lives in the [root README](../README.md#adaptive-thinking--the-short-version).
This is the long version: why Anthropic exposes two thinking contracts on the
same endpoint, how they differ on the wire, which one this gateway picks, and
the verification lesson that cost us a stack of commits to learn.

## The two contracts

Anthropic exposes two different contracts for thinking on the same endpoint,
and the documentation does not make the distinction obvious. They are not
interchangeable.

Send `thinking: { type: "enabled", budget_tokens: N }` and the server assumes
you intend to re-inject the ciphertext signature on the next turn. You get
back an empty thinking block shell and a signed blob that is opaque to anyone
without Anthropic's private keys. Private compute. Great for multi-turn agent
frameworks that want opacity. Useless for an audit pipeline where you want to
actually read what the model was thinking.

## Why we chose adaptive

Send `thinking: { type: "adaptive", display: "summarized" }` together with
`output_config: { effort }` and the server emits `thinking_delta` events
containing the model's reasoning in plaintext. It is summarized — not the raw
internal monologue — but it is readable, and it matches what the official
Claude Code CLI and the OpenCode anthropic plugin emit on the wire.

This gateway picks the second form. That is the entire unlock.

## The verification lesson

Dozens of commits of investigation, one field difference, one lesson learned:
when you claim byte-for-byte parity with another client, verify it with a real
wire capture. Reading their source is not the same thing.

A `mitmproxy` session against the official CLI, with `thinking.type` and
`output_config` logged on every request, would have collapsed the search space
in an afternoon. We did it the long way. You do not have to.

## Cross-links

- [Root README — Adaptive thinking, the short version](../README.md#adaptive-thinking--the-short-version)
- [`src/transform/`](../src/transform/) — the request and response translation that injects `adaptive` + `summarized` and surfaces `thinking_delta` events
- [`OBSERVABILITY.md`](../OBSERVABILITY.md) — event model and SQLite schema where thinking deltas land
