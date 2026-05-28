# project-readme Specification

## Purpose

Defines the structural, content, accuracy, voice, and length contract for the repository's root `README.md`. Documentation capability — requirements describe what the artifact MUST contain, link to, and avoid.

---

## Requirements

### Requirement: Section Structure

The README MUST contain exactly 13 top-level `##` sections, in this order: Title block, Pitch, Disclaimer, Quickstart, API, Dashboard, Architecture, Development & build, Configuration, Adaptive thinking — the short version, Project status & scope, Further reading, License. Per-section purpose is fixed by the change proposal's locked 13-section list. The README MUST NOT contain a nav chip-row above the title block.

#### Scenario: Section order matches contract

- GIVEN the published README
- WHEN `##` headings are extracted in order
- THEN they map 1:1 to the 13 names listed above, in order

---

### Requirement: Title Block Content

The title block MUST contain exactly 3 badges (Bun, TypeScript, License) and MUST NOT contain a live numeric badge (e.g. test count). A one-line status stamp MUST appear directly under the tagline reading: `experimental · unaffiliated with Anthropic · do not deploy to paying users`.

#### Scenario: No drift-prone badge

- GIVEN the title block
- WHEN badges are enumerated
- THEN no badge encodes a numeric claim sourced from runtime state

---

### Requirement: Configuration Accuracy

The Configuration section MUST document every overridable env var in `src/config.ts` with columns name, type, default, purpose. The table MUST include `PORT`, `BIND_HOST`, `CREDENTIALS_PATH`, `ANTHROPIC_CLI_VERSION`, `MAX_RETRY_AFTER_MS`.

#### Scenario: Env var coverage

- GIVEN `src/config.ts` exposes env var `X`
- WHEN the Configuration table is read
- THEN row `X` exists with non-empty default and purpose cells

---

### Requirement: Endpoint, Script, and Path Accuracy

Every endpoint in the API table MUST resolve to a handler under `src/http/routes/`. Every command shown MUST exist in `package.json` scripts or be a valid `bun` invocation. Every path in the Architecture table MUST exist in `src/`. The README MUST NOT contain live numeric claims (test count, line count, route count).

#### Scenario: Quickstart curl is runnable

- GIVEN a fresh checkout with credentials configured
- WHEN the Quickstart `curl GET /v1/models` is run verbatim
- THEN HTTP 200 is returned with a JSON model list

---

### Requirement: Quickstart Shape

Quickstart MUST fit within 40 lines including code blocks, MUST use `curl` against `GET /v1/models` as the first request, and MUST show the expected JSON shape.

#### Scenario: One-screen Quickstart

- GIVEN the Quickstart section
- WHEN line count is measured from `## Quickstart` to the next `##`
- THEN the count is ≤ 40

---

### Requirement: Voice and Framing

The Disclaimer section MUST preserve the existing self-deprecating, non-marketing voice. The README MUST NOT contain promotional language (e.g. "production-ready", "blazing fast"). Exactly one disclaimer block MUST exist.

#### Scenario: Disclaimer count

- GIVEN the README
- WHEN disclaimer-style sections are counted
- THEN the count is 1

---

### Requirement: Linking and Discoverability

The README MUST link to `openspec/`, `CLAUDE.md`, `OBSERVABILITY.md`, `docs/audit-2026-04-17.md`, `docs/adaptive-thinking.md`, and MUST NOT duplicate substantive content from them. The Adaptive thinking section body MUST be ≤ 6 lines plus a link; the full essay lives in `docs/adaptive-thinking.md`.

#### Scenario: Adaptive thinking teaser only

- GIVEN the Adaptive thinking section
- WHEN its body is measured
- THEN length is ≤ 6 lines AND contains a link to `docs/adaptive-thinking.md`

---

### Requirement: Length and Anchor Preservation

Total README length MUST be between 170 and 220 lines inclusive. Anchor slugs `#api`, `#dashboard`, `#architecture`, `#configuration`, `#disclaimer` MUST survive the rewrite. One intentional anchor break (`#about-that-plaintext-reasoning`) is permitted and MUST be documented in design notes.

#### Scenario: Length within budget

- GIVEN the rewritten README
- WHEN line count is measured
- THEN the count is between 170 and 220 inclusive

---

### Requirement: Out-of-Scope Guard

This change MUST NOT modify `CLAUDE.md`, `OBSERVABILITY.md`, any sub-README (including `src/ui/README.md`), source code, `package.json`, or any spec under `openspec/specs/`. The only permitted deletion is the empty orphan folder `openspec/changes/revamp-readme/`.

#### Scenario: No untouched files modified

- GIVEN the change diff
- WHEN paths outside `README.md`, `docs/adaptive-thinking.md`, and `openspec/changes/revamp-readme-md/**` are inspected
- THEN no other files are modified, except deletion of the orphan folder
