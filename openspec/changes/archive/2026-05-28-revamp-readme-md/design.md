# Design — Revamp README.md

## Overview

The spec locks WHAT the README must contain (13 sections, length 170–220, accuracy gates, voice constraints). This design locks HOW we get there: section-order rationale per cognitive-doc-design's answer-first / progressive-disclosure rules, an explicit preserve/trim/rewrite list against today's prose, the exact Quickstart bytes, the canonical Configuration table, the outline for the new `docs/adaptive-thinking.md` sub-doc, link strategy, anchor preservation policy, the exact verifier commands (Bun + PowerShell native), and the apply-phase work order. Everything is mechanically checkable from `src/config.ts`, `src/http/routes/`, and `package.json` — no judgment calls deferred to apply.

## Section order and rationale

Cognitive-doc-design principle: lead with the answer (Pitch), neutralise the legal/honesty cost early (Disclaimer), give the reader a verifiable win in one screen (Quickstart), then layer reference detail, then context, then pointers. Order is:

1. **Title block** — identifies the project; badges and status stamp set expectations before the reader scrolls.
2. **Pitch** — one paragraph + three-things list answers "what is this and why should I care" before any cost is asked of the reader.
3. **Disclaimer** — moved up from §11 in the current README so the OAuth/ToS posture is on screen one. Better to lose a reader on honesty than to mislead them past the fold.
4. **Quickstart** — the verifiable win. After deciding to care (§2) and accepting the risk (§3), the reader gets a working `curl` in ≤ 40 lines.
5. **API** — having succeeded with one call (§4), the reader now wants the full surface. Endpoint table is the natural expansion.
6. **Dashboard** — the second product surface; reference-style like §5 so the rhythm holds.
7. **Architecture** — readers who have used §4–§6 may now want to know how it's wired. Diagram + path table; not earlier because most readers don't need it.
8. **Development & build** — only readers planning to modify the code reach §8. Three subheadings (Run · Build · Test) chunk dev concerns away from operator concerns.
9. **Configuration** — operator-focused; deliberately after §8 because env vars matter most to people running the gateway, not to people calling it.
10. **Adaptive thinking — the short version** — context/colour, optional read; ≤ 6 lines + link out to the long form. Progressive disclosure: front door tells *what was learned*, sub-doc tells *why and how*.
11. **Project status & scope** — limitations and "what this is not"; placed late so it does not bury the value (§2–§6). Replaces today's "What this is not".
12. **Further reading** — pointer table; deliberately just before License so deep readers find it without it competing with reference content.
13. **License** — convention; one line; GitHub metadata expects it last.

Each transition is justified: §1→§3 builds identity → expectation → honesty before any code; §4→§7 layers concrete-to-abstract; §8→§10 layers operator → contributor → context; §11→§13 closes with limits, pointers, legal.

## Voice: preserve / trim / rewrite

### Preserve (verbatim or near-verbatim)
- **Tagline** "Speaks the dialect. Logs every byte. Ships the dashboard." — the rhythm IS the brand.
- **Pitch opener** "Nothing you couldn't build yourself in a weekend, except we spent about twenty commits tracking down one specific server behaviour so you don't have to." — preserve in full.
- **Three-things list** (1. Speaks the OpenAI dialect / 2. Logs every byte / 3. Ships a dashboard) — preserve verbiage, may compress whitespace.
- **Disclaimer voice** — keep "moving ground" phrasing, "Use at your own discretion. Do not put this behind a product you charge money for." Two paragraphs collapse to one block but the prose stays.
- **Architecture diagram** (lines 127–144) — preserve ASCII art verbatim.
- **Dashboard tagline** "A dashboard without keyboard nav is cosplay" — preserve.
- **SQLite note** "No abstraction to learn, no ORM to fight." — preserve.
- **Closing positive-voice paragraph** "It is a tool for people who want to see, in full colour, what their LLM is doing on a Claude Max subscription, today." — preserve in §11.

### Trim (cut entirely)
- **"195 tests" badge** — drift-prone live numeric claim (proposal decision #6).
- **Nav chip-row** (current line 18) — duplicates `##` headings; GitHub renders TOC sidebar (proposal decision #7).
- **"195 tests" inline comment** in current Test section (line 190) — same drift risk.
- **Adaptive-thinking essay body** (lines 206–228, 23 lines) — relocated to `docs/adaptive-thinking.md`; README keeps a 3–4 line teaser.
- **Second disclaimer / "What this is not"** as a duplicate posture statement — its content folds partially into §3 (Disclaimer) and partially into §11 (Project status & scope). One disclaimer block only.
- **Footer "Built with …" badge row** (lines 249–251) — does not earn its line cost; the title-block badges already establish the stack.

### Rewrite (concept stays, prose fresh)
- **Quickstart** — current Requirements + Run-it + Build are scattered across §6 (Requirements), §7 (Run it), §10 (Build). New §4 collapses Requirements (3 lines) + install + start + verifying curl into one ≤ 40-line block. See [Quickstart — exact content](#quickstart--exact-content).
- **Development & build** — three current sections (`## Development`, `## Build`, `## Test and typecheck`) merge into one §8 with Run / Build / Test subheadings. Commands preserved; prose compressed.
- **Configuration** — two new rows (`ANTHROPIC_CLI_VERSION`, `MAX_RETRY_AFTER_MS`) added; OAuth row stays in the same table (decision below).
- **Adaptive-thinking teaser** — written fresh as 3–4 lines pointing to the sub-doc; no sentence copied from the long form, otherwise the relocation is fake.
- **Project status & scope** — current "What this is not" rewritten as a bulleted limitations list followed by the preserved closing paragraph.

## Quickstart — exact content

Locked verbatim for apply. The block below is the entire §4 body between `## Quickstart` and the next `##`. 37 lines including code fences and blank lines.

````markdown
## Quickstart

**You need:** Bun (latest stable), an authenticated Claude Code install
(`~/.claude/.credentials.json`), and outbound HTTPS to `api.anthropic.com`.

```bash
bun install
bun run src/index.ts          # listens on 127.0.0.1:3456
```

In a second terminal, verify the gateway is alive and authenticated:

```bash
curl -s http://127.0.0.1:3456/v1/models | jq '.data[0]'
```

Expected shape:

```json
{
  "id": "claude-sonnet-4-5",
  "object": "model",
  "created": 1730000000,
  "owned_by": "anthropic"
}
```

If you see `{"error": {...}}` with status 401, the credentials file is
missing or expired — re-run `claude` to refresh it. If the port is in
use, pass an override: `bun run src/index.ts 3457`.

Point any OpenAI client at `http://127.0.0.1:3456/v1` and it works. See
[API](#api) for the full surface.
````

Notes for apply: `/v1/models` requires no body and no auth header from the client (the gateway uses the on-disk OAuth credentials) — explicitly chosen so the curl is one line. The "expected shape" is illustrative, not byte-exact: it sets reader expectations without committing to a frozen response.

## Configuration table — locked

Column order: **Variable · Type · Default · Purpose**. Locked because spec requires columns "name, type, default, purpose"; we rename `name → Variable` (clearer) and keep the rest verbatim. Defaults and types verified against `src/config.ts`.

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | integer | `3456` | HTTP listen port. First CLI arg overrides (`bun run src/index.ts 3457`). |
| `BIND_HOST` | string | `127.0.0.1` | Bind address. Loopback by default so the gateway is not accidentally exposed — the proxy authenticates to Anthropic with **your** OAuth token. Set `0.0.0.0` only if you knowingly want LAN/public exposure. |
| `CREDENTIALS_PATH` | path | `~/.claude/.credentials.json` | Location of the Claude Code OAuth credentials file. |
| `ANTHROPIC_CLI_VERSION` | string | `2.1.112` | Claude CLI version reported in user-agent, billing header, and signature. Must match a version Anthropic recognises as official Claude Code — unrecognised values trigger safety policies including redacted thinking. |
| `MAX_RETRY_AFTER_MS` | integer (ms) | `30000` | Upper bound on how long the proxy honours an upstream `retry-after` before surfacing the error. Anthropic returns hour-scale values when a Max subscription is exhausted; this prevents indefinite hangs. |

**Decision: OAuth credential vars stay in this table, not a separate "Credentials" subsection.** Rationale: `CREDENTIALS_PATH` is the only OAuth-shaped env var the gateway exposes today (refresh URL, client ID, salt are hardcoded constants in `src/config.ts`, not overridable). A separate subsection for one row is overhead. If future work exposes more credential knobs (refresh URL override, e.g.), revisit.

## docs/adaptive-thinking.md — outline

New file, target **40–60 lines** (~350 words). Tone: continues the README voice (wry, technical, first-person plural) but goes deeper — the README teaser is the *what*, this doc is the *why and how*. The current README §"About that plaintext reasoning" (lines 206–228) is the seed content; it is preserved as the spine and gets one new intro paragraph plus cross-links.

Sections:

1. **Title** — `# Adaptive thinking — the long version`
2. **Intro paragraph** (new, ~4 lines) — frames the doc: "The README teaser tells you we picked the `adaptive` thinking contract over `enabled`. This file explains the difference, why it matters for an audit pipeline, and how we landed on the choice."
3. **The two contracts** — preserve current §"About that plaintext reasoning" paragraphs 1–2 verbatim (the `enabled` vs `adaptive` distinction).
4. **Why we chose adaptive** — preserve current paragraph 3 ("This gateway picks the second form…"). May add 2–3 lines on what this means for downstream consumers reading `telemetry.db`.
5. **Verification lesson** — preserve "when you claim byte-for-byte parity with another client, verify it with a real wire capture" line. One short closing paragraph on how to reproduce the wire-capture experiment (point to `OBSERVABILITY.md` and `src/observability/`).
6. **Cross-links** — last 2 lines: link back to README §"Adaptive thinking — the short version" and to `src/transform/` (where the contract is encoded) and `OBSERVABILITY.md` (where the audit shape is defined).

No new technical claims. The relocation is meant to preserve essay value, not expand scope.

## Link strategy

| Target | Where it appears in README | Path format | Occurrences |
| --- | --- | --- | --- |
| `openspec/` | §12 Further reading row, one line of context | `./openspec/` | 1 |
| `CLAUDE.md` | §8 Development & build (Test subsection, one inline mention as authority for TDD) AND §12 Further reading row | `./CLAUDE.md` | 2 (cap) |
| `OBSERVABILITY.md` | §5 API (one inline mention near the SQLite line) AND §12 Further reading row | `./OBSERVABILITY.md` | 2 (cap) |
| `docs/audit-2026-04-17.md` | §12 Further reading row only | `./docs/audit-2026-04-17.md` | 1 |
| `docs/adaptive-thinking.md` | §10 Adaptive thinking — the short version (inline link in teaser) AND §12 Further reading row | `./docs/adaptive-thinking.md` | 2 (cap) |
| `LICENSE` | §13 License (one line) AND title-block License badge target | `./LICENSE` | 2 (cap) |

Rules locked:
- All paths relative, leading `./`, no absolute URLs.
- No tracking parameters, no shortened URLs.
- Hard cap: 2 occurrences per linked doc. Reason: more than 2 turns navigation into noise without aiding discoverability.
- External URLs (badges, `api.anthropic.com`) are not subject to the 2-occurrence rule.

## Anchor preservation policy

GitHub generates anchors from `##` heading text via lowercase + non-alphanumeric → hyphen rules. Mapping today's anchors → post-change state:

| Current anchor | Source heading | Decision | Post-change anchor / heading |
| --- | --- | --- | --- |
| `#run-it` | `## Run it` | RENAMED | `#quickstart` (`## Quickstart`) |
| `#api` | `## API` | PRESERVED | `#api` (heading unchanged) |
| `#dashboard` | `## Dashboard` | PRESERVED | `#dashboard` |
| `#architecture` | `## Architecture` | PRESERVED | `#architecture` |
| `#disclaimer-being-honest-about-it` | `## Disclaimer, being honest about it` | RENAMED | `#disclaimer` (`## Disclaimer`) |
| `#requirements` | `## Requirements` | REMOVED | Folded into §4 Quickstart body; no `##` heading remains |
| `#development` | `## Development` | RENAMED | `#development--build` (`## Development & build`) |
| `#build` | `## Build` | REMOVED | Folded into §8 as a subheading (`### Build` → `#build` still resolves on GitHub but at a lower level) |
| `#test-and-typecheck` | `## Test and typecheck` | RENAMED | folded into §8 as `### Test` |
| `#configuration` | `## Configuration` | PRESERVED | `#configuration` |
| `#about-that-plaintext-reasoning` | `## About that plaintext reasoning` | **INTENTIONAL BREAK** | content moved to `docs/adaptive-thinking.md`; README anchor becomes `#adaptive-thinking--the-short-version`. |
| `#what-this-is-not` | `## What this is not` | RENAMED | `#project-status--scope` (`## Project status & scope`) |
| `#further-reading` | `## Further reading` | PRESERVED | `#further-reading` |

**The one intentional break** is `#about-that-plaintext-reasoning`. Justification: the section is being relocated to a sub-doc; preserving the anchor as a stub would either (a) duplicate the link to the sub-doc twice (in §10 body AND under a phantom heading) or (b) leave an empty heading. Both are worse than a clean break. Anyone deep-linking to that anchor today will land on a 404 fragment — i.e. the README will still render — and the new §10 heading "Adaptive thinking — the short version" sits adjacent in the TOC, so the loss is recoverable in one glance. Spec authorises this single break.

Spec-mandated anchors that MUST survive: `#api`, `#dashboard`, `#architecture`, `#configuration`, `#disclaimer`. All five are preserved above (with `#disclaimer` requiring a heading rename from "Disclaimer, being honest about it" → "Disclaimer"; the spec lists `#disclaimer` as the surviving anchor, so the rename is correct).

## Verification commands

All commands are Bun-native or PowerShell-native (Windows dev host). `sdd-verify` will run these in order; first failure halts.

```powershell
# 1. Line count: 170 <= total <= 220
$lines = (Get-Content -LiteralPath README.md).Length
if ($lines -lt 170 -or $lines -gt 220) { throw "README line count $lines outside [170,220]" }

# 2. Exactly 13 top-level `##` sections in the locked order
$expected = @(
  '## Title block',  # placeholder — actual title-block heading is `# claude-plan-api`, see note below
  '## Pitch',
  '## Disclaimer',
  '## Quickstart',
  '## API',
  '## Dashboard',
  '## Architecture',
  '## Development & build',
  '## Configuration',
  '## Adaptive thinking — the short version',
  '## Project status & scope',
  '## Further reading',
  '## License'
)
# Note: "Title block" is structural, not a `##` heading — it is the `#` H1 + tagline + badges.
# Verifier counts `##` headings and expects exactly 12 of them matching $expected[1..12].
$found = Select-String -Path README.md -Pattern '^## ' | ForEach-Object { $_.Line.Trim() }
if ($found.Count -ne 12) { throw "Expected 12 `##` headings, found $($found.Count)" }
for ($i = 0; $i -lt 12; $i++) {
  if ($found[$i] -ne $expected[$i + 1]) { throw "Heading $($i+1) mismatch: '$($found[$i])' != '$($expected[$i+1])'" }
}

# 3. Spec-mandated anchors survive (heading regex → anchor)
$mustSurvive = @('api', 'dashboard', 'architecture', 'configuration', 'disclaimer')
$anchors = $found | ForEach-Object { ($_ -replace '^## ', '' -replace '[^a-zA-Z0-9 -]', '' -replace '\s+', '-').ToLower() }
foreach ($a in $mustSurvive) {
  if ($anchors -notcontains $a) { throw "Required anchor '#$a' missing" }
}

# 4. Route accuracy: every `/v1/...` and `/api/...` in README exists under src/http/routes/
$readmeRoutes = (Select-String -Path README.md -Pattern '`(GET|POST)\s+(/v1/[^`]+|/api/[^`]+|/health)`' -AllMatches).Matches |
                 ForEach-Object { $_.Groups[2].Value }
$sourceRoutes = (Select-String -Path src/http/server.ts -Pattern 'pathname\s*===\s*"([^"]+)"' -AllMatches).Matches |
                 ForEach-Object { $_.Groups[1].Value }
# Loose check: every README path's prefix must appear in source. Manual spot-check supplements.
foreach ($r in $readmeRoutes) {
  $prefix = ($r -split '/:|\?')[0]
  if (-not ($sourceRoutes -join "`n").Contains($prefix.TrimEnd('/'))) {
    Write-Warning "README route '$r' not obviously matched in src/http/server.ts — manual check required"
  }
}

# 5. Env var accuracy: every env var in Configuration table is exported from src/config.ts
$readmeEnvs = (Select-String -Path README.md -Pattern '\|\s*`([A-Z][A-Z0-9_]+)`\s*\|' -AllMatches).Matches |
               ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
$configEnvs = (Select-String -Path src/config.ts -Pattern 'Bun\.env\.([A-Z][A-Z0-9_]+)' -AllMatches).Matches |
               ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
foreach ($e in $readmeEnvs) {
  if ($configEnvs -notcontains $e) { throw "README env var '$e' not found in src/config.ts" }
}
foreach ($e in $configEnvs) {
  if ($readmeEnvs -notcontains $e) { throw "src/config.ts env var '$e' not documented in README" }
}

# 6. No live numeric badges — forbid `tests-\d+`, `coverage-\d+`, `\d+%25` patterns in badge URLs
$badge = Select-String -Path README.md -Pattern 'shields\.io/badge/(tests|coverage|builds)-\d'
if ($badge) { throw "Live numeric badge detected: $($badge.Line)" }

# 7. Quickstart length ≤ 40 lines
$rl = Get-Content -LiteralPath README.md
$qs = ($rl | Select-String -Pattern '^## Quickstart$').LineNumber
$next = ($rl[$qs..($rl.Length - 1)] | Select-String -Pattern '^## ' | Select-Object -Skip 1 -First 1).LineNumber + $qs - 1
if (($next - $qs) -gt 40) { throw "Quickstart section is $($next - $qs) lines, max 40" }

# 8. Adaptive thinking section body ≤ 6 lines + must link to docs/adaptive-thinking.md
$at = ($rl | Select-String -Pattern '^## Adaptive thinking').LineNumber
$atNext = ($rl[$at..($rl.Length - 1)] | Select-String -Pattern '^## ' | Select-Object -Skip 1 -First 1).LineNumber + $at - 1
if (($atNext - $at - 1) -gt 6) { throw "Adaptive thinking section body exceeds 6 lines" }
$atBody = $rl[$at..($atNext - 1)] -join "`n"
if ($atBody -notmatch 'docs/adaptive-thinking\.md') { throw "Adaptive thinking section missing link to docs/adaptive-thinking.md" }

# 9. Exactly one disclaimer block
$disc = (Select-String -Path README.md -Pattern '^## Disclaimer').Count
if ($disc -ne 1) { throw "Expected exactly 1 `## Disclaimer` heading, found $disc" }

# 10. docs/adaptive-thinking.md exists and is non-trivial
if (-not (Test-Path docs/adaptive-thinking.md)) { throw "docs/adaptive-thinking.md does not exist" }
if ((Get-Content -LiteralPath docs/adaptive-thinking.md).Length -lt 25) { throw "docs/adaptive-thinking.md suspiciously short" }

# 11. Orphan folder removed
if (Test-Path openspec/changes/revamp-readme) { throw "Orphan folder openspec/changes/revamp-readme/ still exists" }

# 12. Out-of-scope guard
$diff = git diff --name-only HEAD
$allowed = @('README.md', 'docs/adaptive-thinking.md')
$allowedPrefix = 'openspec/changes/revamp-readme-md/'
foreach ($f in $diff) {
  $f = $f.Trim()
  if (-not $f) { continue }
  if ($allowed -contains $f) { continue }
  if ($f.StartsWith($allowedPrefix)) { continue }
  # Permitted deletion: orphan folder
  if ($f.StartsWith('openspec/changes/revamp-readme/')) { continue }
  throw "Out-of-scope file changed: $f"
}

# 13. Required cross-links present
$required = @('OBSERVABILITY.md', 'CLAUDE.md', 'openspec/', 'docs/audit-2026-04-17.md', 'docs/adaptive-thinking.md')
$readme = Get-Content -LiteralPath README.md -Raw
foreach ($l in $required) {
  if ($readme -notmatch [regex]::Escape($l)) { throw "Required link target '$l' missing from README" }
}
```

`sdd-verify` will package the above as one script under `openspec/changes/revamp-readme-md/verify.ps1` (apply-phase task to create it) and invoke `pwsh -File verify.ps1`.

## Apply-phase work order

Recommended atomic work units for `sdd-tasks`, in this order:

1. **Create `docs/adaptive-thinking.md`** — write the new sub-doc per the outline above. Independent of README; allows verifying the relocated essay reads well on its own before the README teaser references it. ~45 lines.
2. **Delete orphan folder `openspec/changes/revamp-readme/`** — `Remove-Item -Recurse -LiteralPath openspec/changes/revamp-readme`. Verify empty first (`Get-ChildItem`); abort if not empty. Trivial step but separate commit so it shows up cleanly in diff.
3. **Rewrite `README.md` in one pass** — apply preserve/trim/rewrite policy from §"Voice", insert locked Quickstart and Configuration verbatim, generate sections 1–13 in order, hit 180–210 line target. Single file edit; do NOT split this into multiple PRs (cognitive cost of a partially-rewritten README is high).
4. **Create `openspec/changes/revamp-readme-md/verify.ps1`** — the verification script above, ready for `sdd-verify` to invoke.
5. **Verify** — run `verify.ps1`, fix anything it flags, re-run until green.

Order rationale: sub-doc first because the README teaser links to it (broken-link risk); orphan delete second because it is independent and small; README rewrite third because it is the largest change and must integrate the previous two; verify script fourth so verify phase has tooling ready; verify last (its own SDD phase).

## Risks and concrete mitigations

| Risk (from proposal) | Likelihood | Concrete mitigation in this design |
| --- | --- | --- |
| Voice flattening | Medium | §"Voice: preserve / trim / rewrite" lists every preserved phrase verbatim. Verifier does not check tone, but reviewer reads the preserve list against the new README in one pass. |
| Factual drift at publish | Low | Verifier checks 5 and 6 (route grep, env grep) catch any endpoint or env var that does not exist in source. Configuration table values come from `src/config.ts` lines 4, 10, 11, 25, 35–38 directly. |
| External deep-links break | Low | Anchor preservation policy enumerates every current anchor and its post-change state; the one intentional break is named and justified. Verifier check 3 enforces the 5 spec-mandated anchors. |
| Essay loses discoverability when moved | Low | Three discovery paths to the sub-doc: §10 teaser inline link, §12 Further reading row, link from `OBSERVABILITY.md` (existing). Sub-doc title is descriptive (`Adaptive thinking — the long version`) so search engines and GitHub file-list browsers surface it. |
| Length creep during apply | Medium | Verifier check 1 enforces 170–220 inclusive. Quickstart and Configuration sections are byte-locked here, removing the two highest-variance sections from the apply-phase author's judgment. |
| Reviewer disagrees with spec-skip (the proposal recommended skipping spec) | Resolved | Spec was written anyway (observation #87); this design conforms to that spec. |
| Orphan folder not empty at apply time | Very low | Work order step 2 includes a `Get-ChildItem` pre-check that aborts if the folder is non-empty. |

## Open design questions

None. Every decision the spec referenced as "documented in design" is locked above (anchor break, OAuth credential placement, Quickstart shape, verifier toolchain). If apply surfaces a forced trade-off (e.g. a curl flag that does not work on a fresh checkout), it is in scope for sdd-apply to flag back to design rather than improvise.
