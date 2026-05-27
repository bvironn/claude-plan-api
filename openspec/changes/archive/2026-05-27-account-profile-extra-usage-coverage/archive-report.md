# Archive report — account-profile-extra-usage-coverage

> Hybrid artifact (OpenSpec file + Engram observation). Final summary of the
> SDD cycle for this change. Body in Rioplatense voseo; identifiers, commit
> messages y rutas en inglés.

## Resumen ejecutivo

- **Capability promovida**: `account-profile` (NUEVA — primer spec para esta
  área). Antes de este change no existía `openspec/specs/account-profile/`.
- **Requirements committed**: R1..R5, cubriendo `hasExtraUsageEnabled`
  propagation (`true` end-to-end), strict gating de la normalización, log
  emit `account.profile.fetched` shape, in-flight dedup de fetches
  concurrentes, y cache hit/miss (`refreshProfile()` siempre bypasea).
- **Veredicto verify**: PASS — sin CRITICAL ni WARNING. Una SUGGESTION
  cosmética (comentario de compat Bun en `loadFreshAccountModule()`)
  explícitamente NO bloqueante; quedó incorporada al design note del live spec.
- **Producción intacta**: cero cambios bajo `src/`. Todo el diff vive en
  `__tests__/` y `openspec/`.

## Fechas del ciclo

Todo el ciclo SDD corrió en un solo día.

| Fase | Fecha | Observación Engram |
|------|-------|--------------------|
| explore | 2026-05-27 | obs `77` |
| propose | 2026-05-27 | obs `78` |
| spec | 2026-05-27 | obs `81` |
| tasks | 2026-05-27 | obs `82` |
| apply | 2026-05-27 | obs `83` (apply-progress) |
| verify | 2026-05-27 | obs `84` (verify-report) |
| archive | 2026-05-27 | (este reporte) |

## Commits de implementación

Cinco commits atómicos uno-por-requirement, más un fix narrow de TSC, más
el bootstrap consolidado de docs SDD:

| Commit | Subject | Mapea a |
|--------|---------|---------|
| `cb6d553` | `test(account-profile): cover hasExtraUsageEnabled true propagation end-to-end` | R1 (T1.1) |
| `57b8b95` | `test(account-profile): extend strict gating cases for hasExtraUsageEnabled` | R2 (T1.2) |
| `f58d4a2` | `test(account-profile): cover account.profile.fetched log emit shape` | R3 (T1.3) |
| `b53c314` | `test(account-profile): cover inflight dedup of concurrent ensureProfile calls` | R4 (T1.4) |
| `5237127` | `test(account-profile): cover cache-hit no-fetch and refreshProfile always-fetch` | R5 (T1.5) |
| `ef97f21` | `test(account-profile): type emitSpy.mock.calls as unknown[][] in filter callbacks` | post-fix TSC para R3 |
| `c78ca51` | `docs(sdd): account-profile-extra-usage-coverage — exploration, proposal, spec, tasks, apply-progress` | bootstrap SDD (todas las fases doc en un solo commit) |
| _(este commit)_ | `chore(openspec): archive account-profile-extra-usage-coverage` | promoción del capability + mv al archive |

T1.6 (extracción de helpers compartidos) fue correctamente **DROPPED** por
no cumplir su trigger condition (sólo R3 spyea `emit`; R4/R5 no).

## LOC totales del ciclo

```
$ git diff --shortstat 568ce17..HEAD -- __tests__/
 2 files changed, 296 insertions(+), 2 deletions(-)

$ git diff --shortstat 568ce17..HEAD -- openspec/changes/
 5 files changed, 810 insertions(+)
```

- **Tests**: +296 LOC (cómodamente bajo el budget de 400 LOC de review).
- **Docs SDD** (exploration + proposal + spec + tasks + apply-progress): +810 LOC.
- **Producción**: 0 LOC.

## Test status al archivar

- **Scope suite** (`__tests__/domain-account-profile.spec.ts` +
  `__tests__/http-routes-account.spec.ts`): **21 pass / 0 fail**.
- **Full suite** (`bun test`): **262 pass / 2 fail**. Las 2 failures son
  pre-existentes y de **entorno Windows** — verify las corroboró
  independientemente contra el baseline `568ce17`:
  - `__tests__/observability.spec.ts` — usa `fuser` (Linux-only) en
    `beforeAll`.
  - `__tests__/telemetry-upstream-body.spec.ts` — usa `mkdir -p` (POSIX-only).
- **Type-check** (`bun run tsc --noEmit`): **EXIT=0**.

No hay regresiones introducidas por este change.

## Requirements promovidos al live spec

Live spec en `openspec/specs/account-profile/spec.md` (creado en este
archive operation, normalizando los marcadores `## ADDED Requirements`
del delta a `## Requirements` plano). Los IDs R1..R5 y el contenido de
cada SHALL clause se preservan verbatim del delta verificado.

| ID | Requirement | Test coverage |
|----|-------------|---------------|
| R1 | Propagation of `hasExtraUsageEnabled: true` | `__tests__/http-routes-account.spec.ts:107-128`, `__tests__/domain-account-profile.spec.ts:164-174` |
| R2 | Strict gating of the flag normalization (7 input shapes) | `__tests__/domain-account-profile.spec.ts:133-151` |
| R3 | Structured log shape on successful fetch (success + failure scenarios) | `__tests__/domain-account-profile.spec.ts:229-261` |
| R4 | In-flight de-duplication (2 concurrent calls share 1 fetch, slot clears) | `__tests__/domain-account-profile.spec.ts:295-345` |
| R5 | Cache-hit avoids upstream; `refreshProfile()` always fetches | `__tests__/domain-account-profile.spec.ts:383-411` |

## Backing Engram observations (audit trail)

| Topic key | Phase | Obs ID |
|-----------|-------|--------|
| `sdd/account-profile-extra-usage-coverage/exploration` | explore | `77` |
| `sdd/account-profile-extra-usage-coverage/proposal` | propose | `78` |
| `sdd/account-profile-extra-usage-coverage/spec` | spec | `81` |
| `sdd/account-profile-extra-usage-coverage/tasks` | tasks | `82` |
| `sdd/account-profile-extra-usage-coverage/apply-progress` | apply | `83` |
| `sdd/account-profile-extra-usage-coverage/verify-report` | verify | `84` |
| `sdd/account-profile-extra-usage-coverage/archive-report` | archive | _(this report)_ |

## Residual notes para futuros mantainers

1. **`loadFreshAccountModule()` depende del ESM loader de Bun.** Vive
   inline en las primeras ~14 LOC de
   `__tests__/domain-account-profile.spec.ts`. Usa cache-busting via
   `?v=${counter}` en el specifier de import dinámico — un truco
   documentado de Bun. Probado en Bun 1.3.x. Si una release futura de
   Bun cambia el cache-key resolution de ESM, R3/R4/R5 podrían dejar de
   resetear bien el módulo y empezar a interferir entre sí. Mitigación
   está localizada: 14 LOC en un solo bloque, fallback a `mock.module()`
   es trivial. La SUGGESTION del verify quedó incorporada al design note
   del live spec mencionando "Tested on Bun 1.3.x".

2. **Pre-existing Windows env failures.** Los 2 tests que fallan en la
   full suite (`observability.spec.ts` y `telemetry-upstream-body.spec.ts`)
   están en archivos que este change NO tocó (diff vacío contra baseline).
   Usan utilidades Linux-only (`fuser`, `mkdir -p`) sin fallback Windows.
   Si en el futuro se quiere limpiar esto, va como change separado
   (sugerido slug: `windows-test-env-coverage`). NO bloquean nada del
   pipeline upstream — sólo agregan ruido al gate de verify en Windows.

3. **Flag es org-scoped, no account-scoped.** Si un futuro change
   propone aliasar `hasExtraUsageEnabled` en `AccountProfile`, debe leer
   primero el design note del live spec — múltiples account UUIDs
   pueden compartir una organización, así que aliasarlo crearía dos
   sources of truth. La premisa "Add `AccountProfile.hasExtraUsageEnabled`"
   ya fue rota una vez en la fase de exploration de este ciclo;
   documentado para no reabrirse.

4. **R4 determinismo depende de microtask ordering.** El double-kickoff
   sincrónico de `ensureProfile()` (sin `await` entre las dos llamadas)
   garantiza que ambas registren el inflight slot antes del primer
   microtask boundary. Es comportamiento estándar JS, no Bun-specific,
   pero si algún día un quirk del engine lo cambia, R4 puede volverse
   flaky. La assertion es `fetchSpy.mock.calls.length === 1` — falla
   loud, no silent.

## Coherencia spec ↔ design ↔ implementation

- **Spec ↔ tests**: 5/5 requirements cubiertos con tests verdes. Cada
  SHALL clause tiene al menos una scenario que la ejercita
  contra producción real.
- **Design note "org-scoped, no alias"**: respetado — `AccountProfile`
  interface (`src/domain/account.ts:14-22`) sigue sin
  `hasExtraUsageEnabled`.
- **Design note "coverage means tests, not tooling"**: respetado —
  cero deps nuevas, cero changes en `openspec/config.yaml`.
- **Design note "ES-module cache caveat"**: respetado vía
  `loadFreshAccountModule()` en lugar del workaround prohibido `?refresh=1`.

## Persistencia

- **OpenSpec file**: este archivo
  (`openspec/changes/archive/2026-05-27-account-profile-extra-usage-coverage/archive-report.md`).
- **Engram**: topic_key `sdd/account-profile-extra-usage-coverage/archive-report`,
  tipo `architecture`, `capture_prompt: false`, scope `project`.

## Siguiente paso

Ciclo SDD completo. No queda fase pendiente para este change. El
orchestrator puede surfacear al usuario un prompt separado de
"ready to push/PR" si corresponde — eso queda fuera del scope de
este archive.
