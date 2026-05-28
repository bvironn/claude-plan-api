# Exploration: Revamp README.md

## 1. Current state assessment

**File**: `README.md` at repo root — 253 lines, ~10.3 KB.

### Sections currently present (in order)

1. ASCII banner + title + tagline + nav chip-row + 4 shields.io badges (Bun, TS, "tests-195 passing", License MIT).
2. Free-form intro paragraph ("Nothing you couldn't build yourself in a weekend...").
3. "Three things it does" numbered list.
4. **Disclaimer** (OAuth/ToS risk, "do not put this behind a product you charge for").
5. **Requirements** table (runtime / credentials / disk / network).
6. **Run it** (commands, dashboard 503 note).
7. **API** table (11 endpoints) + one `curl` example + SQLite note.
8. **Dashboard** table (7 routes) + keymap table.
9. **Architecture** ASCII diagram + path table + frontend stack paragraph.
10. **Development** (two-terminal flow, Vite proxy).
11. **Build** (UI build only).
12. **Test and typecheck** (backend + UI typecheck) — claims "195 tests".
13. **Configuration** table (3 env vars).
14. **About that plaintext reasoning** — long-form essay on adaptive thinking vs ciphertext signature. ~25 lines.
15. **What this is not** — anti-scope disclaimer.
16. **Further reading** table (OBSERVABILITY.md, CLAUDE.md, LICENSE).
17. Footer "Built with..." credit row.

### Factual accuracy issues (verified against repo today)

| Claim in README | Actual | Severity |
| --- | --- | --- |
| `bun test` → "195 tests passing" badge | Audit doc (2026-04-17) cites 63 tests passing; cached project context cites 195. **Unverified at exploration time.** Number is brittle in a badge. | medium — drift risk |
| `bun run src/index.ts` and `bun run src/index.ts 3457` | `package.json` only declares `start` (`bun src/index.ts`), `dev` (`bun --watch src/index.ts`), and `test`. The README's actual invocations work (Bun runs files directly) but the docs do not match `npm run`-style discoverability. | low — works, but inconsistent with scripts |
| "first CLI arg overrides PORT" | Supported by current entry pattern; needs spot-check in `src/index.ts` during proposal. | low — verify before publishing |
| LICENSE link in "Further reading" | `LICENSE` file exists at repo root → link is valid. | none |
| `OBSERVABILITY.md` link | exists. | none |
| `CLAUDE.md` agent conventions link | exists. | none |
| `src/ui/README.md` (referenced indirectly via dashboard sections) | exists but is the **default Vite/shadcn template stub** — not real docs. Not linked from root README, probably correct. | low |
| Mentions of `~/.claude/.credentials.json` and `CREDENTIALS_PATH` override | Listed in Requirements but the corresponding env var row in **Configuration** is present too — duplicated info. | low — minor redundancy |
| References to features (loop guard, adaptive thinking, model registry fallback catalog, token refresh, output_effort levels) from project context | README mentions adaptive thinking deeply, but does **not** name the loop guard, the model registry fallback, the background OAuth refresh, or output-effort variants explicitly outside the `/v1/models` description ("derived effort variants"). | medium — under-sells real surface |

### Tone and structure assessment (against `cognitive-doc-design`)

**What works well today:**

- Leads with the answer — banner + one-line value prop + 3-bullet "what it does" within first 40 lines.
- Tables for endpoints, env vars, routes, keys — strong recognition-over-recall.
- Honesty section (Disclaimer + "What this is not") earns trust early.
- ASCII architecture diagram gives spatial mental model in one screen.

**Cognitive-load problems:**

- **The "About that plaintext reasoning" section (~25 lines of prose) breaks the otherwise scannable rhythm.** It's a deep-dive essay sitting between Configuration and "What this is not". Belongs in a linked sub-doc or an `<details>` block.
- **Two disclaimers** (top "Disclaimer" + later "What this is not") create review-time confusion: are these the same risks or different?
- **No "Quickstart in 60 seconds" block.** A new integrator has to read Requirements → Run it → API → curl example scattered across 4 sections to assemble a first successful call.
- **The 195-tests badge is a live claim that will drift.** Badges should be CI-derived or removed.
- **No license section** — only a "Further reading" link to `LICENSE`. Most readers expect a one-line License heading.
- **No "Project status / supported" line** near the top — Disclaimer covers risk but not maturity.
- **Nav chip-row** (line 18) duplicates anchors already created by section headings; nice-to-have, not a clear win on mobile width.
- **`src/ui/` is called out in Architecture but the dashboard section does not link to its sub-README** (which today is a template stub anyway).

## 2. Audience map

| Audience | What they need | Where they should land first | Priority |
| --- | --- | --- | --- |
| **First-time integrator** ("can I point my OpenAI client at this?") | 1-sentence pitch, supported API, install, run, one curl example, base URL, models list | Top of README → API table → curl | **PRIMARY** |
| **Operator** (running it locally or under systemd) | Env vars (`PORT`, `BIND_HOST`, `CREDENTIALS_PATH`), exposure warning, log locations, telemetry DB path | Configuration → OBSERVABILITY.md link | PRIMARY |
| **Contributor / maintainer** | Repo layout, conventions, test commands, SDD workflow link, where features live | Architecture → CLAUDE.md → openspec/ link | secondary |
| **AI assistant reading the repo** | Bun-first rules, no-Express, `bun:sqlite`, test runner, file conventions | CLAUDE.md already owns this — README only needs to point | secondary (already served) |
| **Evaluator / skeptic** (is this safe? what's the catch?) | Honest disclaimer, ToS posture, not-production warning, license | Disclaimer + What-this-is-not | secondary |

The current README serves PRIMARY audiences reasonably well but blurs the contributor and evaluator paths.

## 3. Existing doc overlap map

| Topic | Root README owns | CLAUDE.md owns | OBSERVABILITY.md owns | docs/audit-*.md owns | src/ui/README.md owns | openspec/ owns |
| --- | --- | --- | --- | --- | --- | --- |
| What the project IS | ✅ canonical | — | — | — | — | — |
| HTTP API surface | ✅ canonical (summary table) | — | mirror (with query-param detail) | — | — | per-capability specs |
| Run / build / test commands | ✅ canonical | rules only ("use bun") | run command only | — | shadcn add example | — |
| Bun-first conventions (no Express, `bun:sqlite`, etc.) | ❌ should NOT duplicate | ✅ canonical | — | — | — | — |
| Observability internals (event shape, SQLite schema, sinks) | ❌ pointer only | — | ✅ canonical | — | — | — |
| Architecture overview | ✅ one diagram + table | — | pipeline diagram only | — | — | — |
| Dashboard routes / keymap | ✅ canonical | — | UI-surface refresh strategy | — | — | — |
| Adaptive thinking deep-dive | currently ✅ (long essay) | — | — | — | — | better fit as standalone `docs/` |
| Historical context, audits | ❌ | — | — | ✅ canonical | — | archive/ |
| SDD workflow | ❌ (no link today) | — | — | — | — | ✅ (changes/, specs/) |
| License | pointer | — | — | — | — | — |
| UI development / shadcn usage | brief mention | — | — | — | currently stub | — |

**Key conclusions:**

- Root README is the **front door** — it should own pitch, API summary, run/build/test, env vars, architecture-at-a-glance, dashboard summary, license, and pointers to everything else.
- Adaptive-thinking essay is **out of place** in a front-door README. Should move to `docs/adaptive-thinking.md` (or similar) with a one-line teaser + link in the README.
- The README must add a pointer to **`openspec/`** for the SDD workflow — currently invisible to anyone arriving via GitHub.
- `src/ui/README.md` is a stub from the Vite template and is currently dead weight; out of scope for this change but worth noting.

## 4. Recommended target structure (section list with one-line purpose)

1. **Title + tagline + value prop** — one sentence: "OpenAI-compatible gateway in front of your Claude Max OAuth, with full per-byte audit + dashboard."
2. **Badges row** — Bun · TypeScript · License (drop the live test-count badge; replace with CI status badge later if/when CI exists).
3. **At-a-glance** — 3 short bullets: speaks OpenAI dialect · logs every byte · ships dashboard.
4. **Disclaimer (single, prominent)** — OAuth/ToS posture + "do not resell" in one block. Merge with current "What this is not".
5. **Quickstart** — exactly: requirements (one table) → `bun install` → `bun run src/index.ts` → one curl against `/v1/chat/completions` → expected shape. The whole block should fit on one screen.
6. **API** — endpoint table (current one is good; trim curl example to be part of Quickstart, not a separate block).
7. **Dashboard** — routes table + keymap. Unchanged in spirit.
8. **Configuration** — env-var table (`PORT`, `BIND_HOST`, `CREDENTIALS_PATH`). Move the credentials-path note here; remove duplicate from Requirements.
9. **Architecture at a glance** — keep the ASCII diagram + path table. Remove the frontend-stack paragraph or compress to one line; depth lives in code.
10. **Development & build** — merge current Development + Build + Test sections into one workflow block with three subheadings or three rows.
11. **Project status & scope** — supported models pointer (link to `/v1/models` route), known limitations (single-tenant, OAuth-from-disk, no SLA). Replaces "What this is not".
12. **Further reading** — table linking `OBSERVABILITY.md`, `CLAUDE.md`, `openspec/` (new), `docs/audit-2026-04-17.md` (new), `LICENSE`. Add `docs/adaptive-thinking.md` if the essay moves out.
13. **License** — one line, "MIT — see LICENSE".

Indicative length target: **~180–210 lines**, down from 253, with the saved budget paying for the SDD pointer and a tighter Quickstart.

## 5. Scope

### In scope

- Rewriting `README.md` against the structure above.
- Removing the live "195 tests" badge (it drifts).
- Consolidating the two disclaimers into one section.
- Adding a Quickstart that produces a first successful curl response.
- Adding a pointer to `openspec/` and the SDD workflow.
- Adding a pointer to `docs/audit-2026-04-17.md` under Further reading.
- Fact-checking every command, route, and env-var claim against the codebase before publishing.
- Tightening or relocating the "About that plaintext reasoning" essay.

### Out of scope

- Modifying `CLAUDE.md`, `OBSERVABILITY.md`, or any sub-README (e.g. `src/ui/README.md` cleanup).
- Adding new docs in `docs/` beyond the optional relocation of the adaptive-thinking essay (decision deferred to proposal).
- Setting up CI or producing a real test-count/CI badge — only requires removing the brittle hardcoded one.
- Adding screenshots, GIFs, or marketing assets.
- Changing any source code, route, or behavior.
- Translating the README.

## 6. Open questions for the proposal phase

1. **Adaptive-thinking essay — keep, trim, or relocate?** Three options: (a) keep in README, (b) compress to a 5-line callout with a link, (c) move whole essay to `docs/adaptive-thinking.md`. Pick one before specing.
2. **Quickstart curl example — which endpoint and what body?** A minimal `POST /v1/chat/completions` with `model: claude-haiku` (or whatever the smallest supported family alias resolves to) is the strongest first impression. Confirm which model alias is safe to recommend without OAuth surprises.
3. **Should we add a "Supported models" subsection** or rely on linking `GET /v1/models` at runtime? Listing models statically will drift; linking the route is the cognitive-doc-design-correct move.
4. **License heading** — promote to a top-level section, or keep as a one-row pointer in "Further reading"? Convention favors a dedicated section.
5. **Project status line** — explicit "Status: experimental / unsupported by Anthropic" stamp near the top? Disclaimer covers this but a one-liner near the title aids scanability.
6. **Drop, keep, or replace the badge row?** Current badges are decorative; the test-count badge actively misleads. Decide on a CI badge or none.
7. **Should the nav chip-row stay?** It duplicates section headings but does help on long-scroll. Cognitive-doc-design says signposting is good — but only if it adds something the TOC/headings don't.
8. **`src/ui/README.md` is a Vite stub** — flag as a separate future change, or quietly note in "Further reading" as not-yet-documented? Recommend: out of scope, separate change.
9. **Hardcoded port `3456`** appears in 3+ places (README, Vite proxy text, docs). Should the README centralize this and link, or repeat it? Repetition is fine if all sites stay in sync; cleaner to centralize.

## 7. Risks and tradeoffs

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| **Drift between README claims and code** (endpoints, env vars, model names, test counts) | High over time | Remove all live numeric claims (test count). Verify every route/env var during apply phase against the actual source. Add a checklist in the proposal so the same thing is rechecked on each future README touch. |
| **Duplication with `CLAUDE.md`** if README starts repeating Bun rules | Medium | Strict policy: README points to CLAUDE.md for agent/dev rules, never restates them. Only the run/build/test commands appear in README — not the underlying conventions. |
| **Length creep** (every section feels essential to the author) | Medium | Lock target range (~180–210 lines) in the proposal. Anything that doesn't fit moves to `docs/`. |
| **Losing the personality** that gives the current README its trustworthy voice ("Nothing you couldn't build yourself in a weekend") | Medium | Explicitly preserve the disclaimer voice and the "what this is / is not" honesty. Cognitive-doc-design is about structure, not tone scrubbing. |
| **Removing the adaptive-thinking essay risks losing search-engine and reader value** | Low–Medium | If relocated, keep a meaningful 3–4 line teaser in README with anchor link to `docs/adaptive-thinking.md`. |
| **Reviewer cost** of a large doc rewrite is high if shipped as one diff | Medium | Plan a single tightly-scoped PR. Cognitive-doc-design's PR guidance: state what to review first (the new section structure), what's intentionally out of scope (no sub-docs touched). |
| **Breaking existing deep links** to README anchors from external sites/issues | Low | Keep section heading names close to current ones where feasible (API, Dashboard, Architecture, Configuration). |
| **Badges add cognitive cost without value if decorative** | Low | Keep at most 3: Bun, TypeScript, License. Drop test-count. Re-add CI status only when CI exists. |

---

## Ready for proposal

**Yes.** The current README is structurally healthy but carries three concrete defects: a drift-prone live badge, two overlapping disclaimers, and a 25-line essay that belongs in a sub-doc. The proposal phase should:

- Lock the target structure in section 4.
- Resolve the 9 open questions in section 6 (especially Q1, Q2, Q4).
- Cite this exploration's "factual accuracy" table as the verification checklist for the apply phase.
