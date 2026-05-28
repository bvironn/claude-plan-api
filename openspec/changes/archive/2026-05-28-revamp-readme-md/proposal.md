# Proposal — Revamp README.md

## Intent

Rewrite the repo's root `README.md` so a first-time integrator can produce a
successful API call in under one screen of scrolling, an operator can find
every env var and exposure warning in one place, and a contributor can
discover the SDD workflow (`openspec/`) and the audit history (`docs/`) that
are currently invisible from the front door. The current README is
structurally healthy but carries three concrete defects that the exploration
already named: a drift-prone live test-count badge, two overlapping
disclaimers, and a 25-line adaptive-thinking essay that breaks the otherwise
scannable rhythm. This change fixes those three, adds the missing pointers,
and locks the structure against future drift.

## Why now

- The "195 tests" badge is a live numeric claim baked into a static
  shields.io URL. It will drift the next time `bun test` adds or removes a
  test. Audit doc `docs/audit-2026-04-17.md` already disagrees with it.
- `openspec/` and `docs/audit-2026-04-17.md` exist in the repo but the
  README never points at them. A reader arriving via GitHub has no on-ramp
  to either the SDD workflow or the audit history.
- The adaptive-thinking section is genuinely valuable content but it is
  sitting in the front-door doc as a 25-line essay, which makes the README
  hard to skim and pushes the "What this is not" disclaimer below the fold.
- Two undocumented env vars (`ANTHROPIC_CLI_VERSION`, `MAX_RETRY_AFTER_MS`)
  exist in `src/config.ts` today; this revamp is the moment to surface them
  truthfully in the Configuration table.

The work is bounded: a single file (plus one new sub-doc and the deletion of
an empty orphan folder). It is also high-leverage — every future reader is
the audience.

## Decisions on open questions

The exploration queued 9 open questions plus one carpeta-huérfana question.
Each is resolved below with a one-line rationale.

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Adaptive-thinking essay — keep, trim, or relocate? | **Relocate** to `docs/adaptive-thinking.md` with a 3–4 line teaser + anchor link in the README. | Cognitive-doc-design says progressive disclosure: front door states *what*, sub-doc explains *why*. The essay is search-engine and trust-building content, not first-impression content. |
| 2 | Quickstart curl — which endpoint and body? | Use **`GET /v1/models`** (not `/v1/chat/completions`) for the Quickstart curl. | A models list call is the canonical OpenAI-client first request, requires zero body decisions, costs no OAuth tokens, and proves the gateway is alive and authenticated. Adds a second optional `curl` for `/v1/chat/completions` with `model: claude-3-5-haiku-latest` *after* the Quickstart, in the API section. |
| 3 | "Supported models" subsection vs. linking `/v1/models`? | **Link the route**. Do not list models statically. | Static lists drift. The route is the source of truth and the Quickstart curl already demonstrates it. |
| 4 | License heading — top-level or pointer? | **Top-level `## License` section** with one line: "MIT — see [`LICENSE`](./LICENSE)." | Convention. Also satisfies GitHub's repo-metadata expectations. Pointer in Further reading is removed (no duplication). |
| 5 | Explicit "Status: experimental" stamp near the top? | **Yes — one line** under the tagline: "Status: experimental · unaffiliated with Anthropic · do not deploy to paying users." | Bridges the gap between a flat tagline and a 12-line disclaimer. Earns trust fast without forcing the reader through prose. |
| 6 | Badge row — drop, keep, or replace? | **Keep 3 badges**: Bun · TypeScript · License. **Drop** the test-count badge. No CI badge yet (no CI exists). | Test-count is the live-claim drift risk; CI badge can be added in a separate change when CI is set up. |
| 7 | Nav chip-row — stay or go? | **Drop**. | It duplicates the section headings, adds visual weight at the top, and most modern GitHub viewers render a TOC sidebar. Cognitive-doc-design: signposting must add something, not echo. |
| 8 | `src/ui/README.md` (Vite stub) — flag now or separately? | **Out of scope**. Filed as a follow-up at the end of this proposal. | One change, one purpose. The stub is harmless; cleaning it is a separate decision (delete vs. replace with real UI dev docs). |
| 9 | Hardcoded port `3456` — centralize or repeat? | **Repeat**, but anchor every mention to the Configuration table via inline backtick + a single "default port `3456` — override with `PORT` or first CLI arg" sentence near the Quickstart. | Centralizing a port number in prose adds cognitive overhead for a 4-character value. Repetition is fine if the Configuration table is the canonical source. |
| 10 | Orphan folder `openspec/changes/revamp-readme/` (without `-md`) | **Delete** as part of the apply phase for this change. | Folder is verified empty (no files, no subfolders). Keeping our slug as `revamp-readme-md` is correct because Engram session and observation references already use it. Consolidating to the shorter slug would invalidate cross-references. |

## Scope

### In scope

- Rewriting `README.md` at the repo root to the locked structure below.
- Creating `docs/adaptive-thinking.md` with the relocated essay (relocation,
  not rewrite — the existing prose is preserved verbatim with a one-paragraph
  intro stating "extracted from the root README for cognitive load reasons").
- Deleting the empty orphan folder `openspec/changes/revamp-readme/`.
- Verifying every endpoint, env var, default value, and command in the new
  README against the actual source (`src/http/routes/`, `src/config.ts`,
  `package.json`, `src/index.ts`) during the apply phase.
- Adding two currently-undocumented env vars (`ANTHROPIC_CLI_VERSION`,
  `MAX_RETRY_AFTER_MS`) to the Configuration table.
- Removing the "195 tests" badge.
- Merging the two disclaimers into one prominent section.
- Adding a Further-reading row pointing to `openspec/` and one to
  `docs/audit-2026-04-17.md`.

### Out of scope

- Any changes to `CLAUDE.md`, `OBSERVABILITY.md`, or any other root-level
  doc. The README will *link* to them; it will not restate their content.
- Any changes to `src/ui/README.md` (the Vite/shadcn stub). Tracked as a
  follow-up below.
- Setting up CI, producing a CI status badge, or adding any dynamic badge.
- Adding screenshots, GIFs, animated demos, or marketing assets.
- Any source-code change, route change, env-var renaming, or behavior
  change. This is strictly a documentation revamp.
- Translating the README into other languages.
- Rewriting `docs/audit-2026-04-17.md` or any other file under `docs/`.
- Reorganizing `openspec/` itself beyond deleting the one verified-empty
  orphan folder named above.

## Target structure (final, locked)

The new README will have **exactly these 13 top-level sections**, in this
order. Section names are locked so future edits know where to add or trim.

1. **Title block** — ASCII banner (preserved), `# claude-plan-api`, tagline
   line, one-line status stamp, 3 badges (Bun · TS · License). No nav
   chip-row.
2. **Pitch** — the existing "Nothing you couldn't build yourself in a
   weekend" voice + the three-things-it-does numbered list. Trimmed to keep
   the title block + pitch under ~30 lines so the Quickstart appears within
   one screen.
3. **Disclaimer** — single, consolidated. Merges current "Disclaimer, being
   honest about it" with the body of "What this is not". Preserves voice.
4. **Quickstart** — Requirements row (compressed from current table to 3
   lines), `bun install`, `bun src/index.ts`, one `curl GET /v1/models`,
   expected response shape (3–4 lines of JSON). Whole section ≤ 40 lines.
5. **API** — endpoint table (current 11 rows, verified), one richer `curl`
   example against `/v1/chat/completions` with a non-streaming body, SQLite
   queryability note.
6. **Dashboard** — routes table + keymap table. Unchanged in spirit; verify
   route list against `src/ui/` routing during apply.
7. **Architecture** — ASCII diagram + path table. Frontend-stack paragraph
   compressed to one line ("Vite + React 19 + TanStack + Tailwind v4 +
   shadcn/ui, served from the same port — no CORS, no separate deploy").
8. **Development & build** — merged. One block with three subheadings (Run
   two terminals · Build the UI · Test & typecheck). Test command shown
   without a count.
9. **Configuration** — env-var table. Expanded to include
   `ANTHROPIC_CLI_VERSION` and `MAX_RETRY_AFTER_MS`. The `BIND_HOST`
   exposure warning stays.
10. **Adaptive thinking — the short version** — 3–4 line teaser explaining
    the contract choice in one paragraph, with link to
    `docs/adaptive-thinking.md` for the full essay.
11. **Project status & scope** — Replaces "What this is not". Lists known
    limitations (single-tenant, OAuth-from-disk, no SLA, no official
    support) as a tight bullet list. The closing positive-voice paragraph
    ("It is a tool for people who want to see, in full colour…") is
    preserved.
12. **Further reading** — table linking `OBSERVABILITY.md`, `CLAUDE.md`,
    `openspec/` (new), `docs/audit-2026-04-17.md` (new),
    `docs/adaptive-thinking.md` (new). `LICENSE` is **not** in this table
    because it gets its own top-level section (decision Q4).
13. **License** — one line: "MIT — see [`LICENSE`](./LICENSE)."

Footer "Built with…" credit row stays (it's atmosphere, not content).

Indicative length target: **180–210 lines**, down from 253. Saved budget pays
for the SDD pointer, the two new env vars in Configuration, and the status
stamp.

## Acceptance criteria

Observable, checkable outcomes the verify phase will assert against:

- [ ] `README.md` total line count is between **170 and 220** (inclusive).
- [ ] README contains **exactly the 13 sections** named in "Target
      structure (final, locked)", in order, with matching `##` headings.
- [ ] README contains **no live numeric claims** — no "N tests", no "N
      endpoints", no "N routes" hardcoded. (Tables that list endpoints by
      name are fine; counts in prose or badges are not.)
- [ ] Badge row contains **exactly 3 badges**: Bun, TypeScript, License.
      No test-count badge.
- [ ] Every endpoint in the API table exists in `src/http/routes/` (or
      equivalent server-registration site). No orphan rows.
- [ ] Every env var in the Configuration table exists in `src/config.ts`.
      Every env var in `src/config.ts` that an operator can usefully
      override is in the table (`PORT`, `BIND_HOST`, `CREDENTIALS_PATH`,
      `ANTHROPIC_CLI_VERSION`, `MAX_RETRY_AFTER_MS`).
- [ ] Every command shown (`bun install`, `bun src/index.ts`,
      `bun test`, `bunx tsc --noEmit`, `bun run dev` in `src/ui`,
      `bun run build` in `src/ui`) exists in `package.json` or works
      directly with Bun's file-runner semantics.
- [ ] The Quickstart section (heading to next `##`) is **≤ 40 lines**.
- [ ] Quickstart includes one runnable `curl` against `/v1/models` and the
      expected JSON shape (truncated, illustrative — not full output).
- [ ] There is exactly **one disclaimer section**, not two.
- [ ] The adaptive-thinking essay does **not** appear in full in the
      README. A teaser of ≤ 6 lines + a link to `docs/adaptive-thinking.md`
      is the only adaptive-thinking content in the README.
- [ ] `docs/adaptive-thinking.md` exists, contains the relocated essay
      (preserving the current voice), and has a one-paragraph intro stating
      it was extracted from the root README.
- [ ] `openspec/changes/revamp-readme/` (the orphan, without `-md`) no
      longer exists.
- [ ] Further reading table contains rows for `OBSERVABILITY.md`,
      `CLAUDE.md`, `openspec/`, `docs/audit-2026-04-17.md`, and
      `docs/adaptive-thinking.md`.
- [ ] `## License` is a top-level section in the README.
- [ ] No CORS, no new dependencies, no `package.json` change, no source
      change.

## Impact

### Files touched

| File | Kind | Notes |
|------|------|-------|
| `README.md` | modify | Full rewrite against locked structure. |
| `docs/adaptive-thinking.md` | create | Relocated essay (~30 lines incl. intro). |
| `openspec/changes/revamp-readme/` | delete | Empty orphan folder. Verified empty during proposal phase. |
| `openspec/changes/revamp-readme-md/proposal.md` | already created | This file. |
| `openspec/changes/revamp-readme-md/design.md` | will be created by sdd-design | — |
| `openspec/changes/revamp-readme-md/tasks.md` | will be created by sdd-tasks | — |

No source code is touched. No `package.json`, no `tsconfig.json`, no
`.gitignore`. No sub-READMEs touched.

### Estimated changed lines

Best-effort line-budget for the review-workload guard:

| File | Lines removed | Lines added | Net |
|------|---------------|-------------|-----|
| `README.md` | ~253 | ~195 | -58 |
| `docs/adaptive-thinking.md` | 0 | ~35 | +35 |
| Orphan folder | 0 | 0 | 0 |
| **Total** | **~253** | **~230** | **~+483 changed lines** |

For the review-budget guard (600-line ceiling), this is well within one PR.
The change can ship as a single PR without chained-pr slicing.

### Risk

**Low.**

Reasoning:
- Documentation-only. No code, no behavior, no API surface change.
- No spec change in the SDD sense — no capability/requirement deltas.
- The Quickstart curl and Configuration table will be verified
  empirically against the running code in the verify phase, removing the
  largest documentation-risk class (factual drift at publication).
- The orphan folder deletion is verified empty before the apply phase
  touches it.
- The adaptive-thinking relocation is a copy-paste with a teaser, not a
  rewrite, so semantic drift risk on that content is near-zero.

Residual low risks:
- Voice preservation. Cognitive restructuring can flatten personality.
  Mitigated by explicit "preserve voice" requirement in the design phase
  and a verify-phase reviewer check.
- External deep-links to current README anchors. Mitigated by keeping
  section names close to the current ones where feasible (`api`,
  `dashboard`, `architecture`, `configuration`, `disclaimer`,
  `further-reading` — all preserved with minor casing).

### Reviewer burden

The cognitive-doc-design skill's PR guidance applied:

- **Review first**: the new section order in the locked target structure
  (proposal §"Target structure"). If that's right, the rest is wording.
- **Out of scope** (state explicitly in the PR description): CLAUDE.md,
  OBSERVABILITY.md, src/ui/README.md, screenshots, CI badges, source code.
- **Suggested review path**:
  1. Read the proposal's "Acceptance criteria" checklist.
  2. Read the new README top-to-bottom in one pass (≤ 220 lines).
  3. Spot-check 3 random claims (one route, one env var, one command)
     against the source.
  4. Skim `docs/adaptive-thinking.md` to confirm it's the same essay,
     not a rewrite.
- **Single PR, no chaining needed.** ~483 changed lines, well under the
  600-line review budget.

## Verification approach

The verify phase will mechanically prove every factual claim. Concretely:

| Claim class | Verification source | Method |
|-------------|---------------------|--------|
| Endpoint table rows | `src/http/routes/` (or the route-registration file) | List actual registered routes, diff against the README table. |
| Env var table rows | `src/config.ts` | Confirm every documented env var is read from `Bun.env.*` in `src/config.ts`; confirm every overridable env var is documented. |
| Default values (port, bind host, credentials path) | `src/config.ts` constants | String-match defaults shown in README against the actual constant values. |
| Commands | `package.json` scripts + Bun runner semantics | Each command shown is either a `package.json` script or a direct `bun <file>` invocation that works with Bun. |
| Dashboard routes | `src/ui/` routing (TanStack file-based router) | List files under the route directory; diff against README table. |
| Architecture path table | `src/` directory listing | Each row's path exists. |
| Adaptive-thinking content | `git diff` between current README §"About that plaintext reasoning" and `docs/adaptive-thinking.md` | Verify the prose is preserved verbatim (modulo the new intro paragraph). |
| Line-count and section-count acceptance criteria | `wc -l` on `README.md`, grep for `^## ` | Mechanical. |
| Orphan folder deletion | `Test-Path openspec/changes/revamp-readme` (without `-md`) | Must return False. |

If any verification step fails, the verify phase blocks and the apply phase
is reopened.

## Spec phase

**Recommendation: skip the spec phase** and proceed directly to
`sdd-design` → `sdd-tasks` → `sdd-apply` → `sdd-verify` → `sdd-archive`.

Justification:
- This change introduces, modifies, or removes **zero capabilities** in the
  SDD sense. No requirement is added, deleted, or reworded.
- SDD's `openspec/specs/` describes *what the system does*. A README revamp
  changes *how the system is documented*, not what it does.
- All observable acceptance criteria for this change live above in the
  "Acceptance criteria" section of this proposal. Encoding them again as
  delta specs would duplicate without adding signal.
- The OpenSpec convention treats docs-only changes as a legitimate skip
  case for the spec phase, provided acceptance criteria are present in the
  proposal — which they are.

This decision is reversible: if the design phase surfaces an unexpected
capability-shaped concern, we can drop back into `sdd-spec` before applying.

## Design phase preview

What `sdd-design` will need to cover (so the design author knows the scope
before starting):

- **Section-order rationale**: why these 13 sections in this order, justified
  against the cognitive-doc-design skill's progressive-disclosure rule
  (lead with answer, details next, deep references last). Each section gets
  a one-paragraph justification.
- **Voice and tone guidelines**: an explicit "preserve" list (the
  "Nothing you couldn't build yourself in a weekend" pitch, the
  Disclaimer's plain honesty, the "It is a tool for people who want to see…"
  closing paragraph) and a "trim" list (the long-form adaptive-thinking
  prose moves out; the nav chip-row goes; redundant disclaimer wording
  merges).
- **Link strategy**: every link is relative (`./OBSERVABILITY.md`,
  `./openspec/`, etc.). Every external link (shields.io badges) is
  approved one-by-one. No tracking links, no shortened URLs.
- **Anchor preservation policy**: which current anchors must survive
  (`#api`, `#dashboard`, `#architecture`, `#configuration`,
  `#disclaimer`) and which are allowed to change
  (`#about-that-plaintext-reasoning` is moving out, so its anchor will
  break — that's expected and the relocated essay's new home is
  `docs/adaptive-thinking.md`).
- **Quickstart curl exact content**: the literal `curl` line and the
  literal expected-output JSON shape, so the apply phase has a concrete
  spec to copy and the verify phase has a concrete claim to test.
- **Adaptive-thinking sub-doc shape**: the structure of
  `docs/adaptive-thinking.md` — intro paragraph, the two-contracts
  explanation, the lesson-learned closer. Length target ≤ 60 lines so the
  sub-doc itself remains scannable.
- **Configuration table column choices**: confirm the columns
  (Env · Default · Notes) and the row order, since two new rows are being
  added.

## Risks and mitigations

| Risk | Likelihood | Severity | Mitigation |
|------|-----------|----------|------------|
| Voice flattening during restructure | Medium | Medium | Design phase locks a "preserve" list of exact sentences and tonal cues. Verify phase includes a tonal spot-check. |
| Factual drift at publication time (a route renamed last week, an env var added yesterday) | Low | High | Verify phase mechanically diffs README claims against source. Apply phase reads `src/http/routes/` and `src/config.ts` *during* the rewrite, not from memory. |
| External deep-links break | Low | Low | Section names kept close to current; anchor preservation policy is part of design phase. The intentional break (`#about-that-plaintext-reasoning`) is documented. |
| Adaptive-thinking essay loses discoverability when moved | Low | Low | Teaser + explicit link in README + row in Further reading table + the sub-doc title contains "adaptive thinking" for SEO. |
| Length creep during apply (every section feels essential) | Medium | Low | Acceptance criterion locks 170–220 line range. If apply phase blows the budget, design has to cut, not the verify phase. |
| Reviewer disagrees with the spec-skip decision | Low | Low | Decision documented above with reversibility note. Re-opening to add a delta spec is cheap. |
| Orphan folder turns out not to be empty (race / late commit) | Very low | Low | Verify-on-delete: apply phase will re-check `Get-ChildItem -Recurse -Force` returns empty before `Remove-Item`. |

## Open follow-ups (post-change)

These are intentionally **not** part of this change. Each should become its
own SDD change when prioritized.

1. **`src/ui/README.md` is a Vite/shadcn template stub.** Decide: delete it,
   or replace with real UI-development docs covering routing conventions,
   shadcn-add usage, and the proxy setup. Out of scope here.
2. **CI status badge.** When/if CI is set up, add a CI status badge to the
   README's 3-badge row (becomes 4). Tracked separately.
3. **Test-count surfacing.** If a future change wants a test count
   surfaced, it should come from a CI-generated badge (Codecov-style), not
   a hardcoded shields.io URL.
4. **OpenSpec README pointer reciprocity.** If `openspec/README.md` ever
   gains a "what this is" intro, link back to the root README from there.
   Currently `openspec/` has no top-level explainer.
5. **Translate to Spanish** (community ask, not committed). If undertaken,
   should live at `README.es.md` and the English version should add a
   one-line language switcher near the title.
