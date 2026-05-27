# Proposal: AccountProfile extra-usage coverage hardening

> **Framing correction (read this first)**: `hasExtraUsageEnabled` ya existe y vive
> en `OrganizationProfile` (`src/domain/account.ts:30`), normalizado desde
> `organization.has_extra_usage_enabled` upstream. **No es un campo de
> `AccountProfile`** y este cambio **NO lo va a aliasar**. El framing original
> "Add `AccountProfile.hasExtraUsageEnabled`" era una premisa rota. Este change
> cierra huecos de cobertura alrededor del flag tal como vive hoy.

## Intent

El flag `hasExtraUsageEnabled` tiene una cadena observable
(upstream → normalize → cache → HTTP response → log emit) con huecos concretos
de test enumerados en `exploration.md`. Esos huecos son el riesgo real: si
Anthropic devolviera `true`, si rompemos el shape del log, o si la dedup de
`inflight` se desincroniza, ningún spec actual se entera. Esta propuesta
endurece la cobertura de esa cadena, sin tocar tipos ni semántica.

## Scope

### In Scope

1. **Happy-path con `hasExtraUsageEnabled: true`** — Hoy todos los fixtures
   usan `false`. Agregar test que ejercite `true` y verifique propagación
   `normalize` → cache → JSON de `GET /api/account/profile`.
2. **Log emit shape coverage** — Test que asegura que
   `emit("info", "account.profile.fetched", …)` contiene
   `hasExtraUsageEnabled` con el valor correcto. Usar `spyOn` estándar
   del logger.
3. **Cache concurrency (`inflight` dedup)** — Dos `ensureProfile()`
   concurrentes deben producir **un solo fetch upstream** y resolver al mismo
   `FullProfile` cacheado (`src/domain/account.ts:67-68`).
4. **Cache hit vs miss directo** — Cobertura unitaria de `ensureProfile()`
   cold→fetch luego hot→no-fetch, evitando el workaround `?refresh=1` que hoy
   los route specs usan por caching de ES modules.
5. **Nota documentada en el proposal** — Este párrafo y el de "Framing
   correction" dejan asentado que el flag es org-scoped, para que futuros
   agentes no reabran la premisa rota.

### Out of Scope

- ❌ Agregar `hasExtraUsageEnabled` (o alias) a `AccountProfile`. El flag es
  semánticamente **org-scoped** (múltiples account UUIDs pueden compartir org);
  duplicarlo falsificaría el modelo upstream y crearía dos sources of truth.
- ❌ Tocar `src/upstream/beta-exclusion.ts` o `anthropic-client.ts` para
  preflight gating del beta `context-1m-2025-08-07` (Approach D del explore,
  futuro change separado).
- ❌ Agregar tooling de coverage (c8/istanbul). `coverage.available: false`
  en `openspec/config.yaml` es su propio change multi-día. Acá agregamos
  tests, no medimos %.
- ❌ Renombrar, mover, o modificar tipos existentes (`AccountProfile`,
  `OrganizationProfile`, `FullProfile`, `ApplicationProfile` se quedan
  como están).

## Capabilities

### New Capabilities

- `account-profile`: Modelo de dominio + endpoint HTTP para el perfil de cuenta
  (account + organization + application), normalización desde Anthropic
  `/api/oauth/profile`, cache in-memory con dedup de fetches concurrentes, y
  log emit `account.profile.fetched`. Capability nueva porque hoy no existe
  spec para esta área (`openspec/specs/` sólo tiene `completions-endpoint` y
  `transform-sanitization`).

### Modified Capabilities

- None.

## Approach

Approach B del exploration — **coverage-only**. Cinco tests nuevos, uno por
gap, organizados como TDD estricto: cada spec se commitea RED primero
(probando que el gap existe), luego se agrega fixture/helper mínimo para
ponerlo GREEN. Helpers y fixtures aterrizan junto al spec que los necesita,
no preemptivamente.

**Strict TDD nota**: como toda la implementación SON tests, la disciplina
test-first se traduce a "demostrar el gap escribiendo un test rojo antes de
cualquier helper que lo ponga verde". `sdd-tasks` debería partir el trabajo en
una task por gap (5 tasks) para que cada uno sea un atomic work-unit commit.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `__tests__/domain-account-profile.spec.ts` | Modified | +3 tests: happy-path-true, cache hit/miss, inflight dedup |
| `__tests__/http-routes-account.spec.ts` | Modified | +2 tests: log emit shape, end-to-end con `true` |
| `__tests__/fixtures/` (posible nuevo archivo) | New | Fixture compartido con `has_extra_usage_enabled: true` si la duplicación inline incomoda |
| `src/domain/account.ts` | None | Sin cambios. |
| `src/http/routes/account.ts` | None | Sin cambios. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Test de `inflight` dedup timing-sensitive (race entre dos `ensureProfile()`) | Med | Usar `Promise.all` con un fetch mock que retorna una `Promise` controlada; afirmar count del mock, no timing. |
| Log emit test frágil si la API del logger cambia | Low | Spyear el módulo `observability/logger` por nombre, no por shape interna; matchear sólo las keys que importan. |
| ES-module caching en `bun:test` cruza cobertura cache entre tests | Med | Resetear el módulo (`mock.module` o re-import dinámico con `import.meta`) en el `beforeEach` del bloque de cache; documentado ya en el spec actual. |

## Rollback Plan

Revert del PR (o de los slices encadenados, si `sdd-tasks` recomienda chain).
Como no se modifica código de producción, el rollback no tiene impacto
funcional — sólo se pierde la cobertura agregada. Si un test resulta flakey
en CI, se puede `.skip` el caso puntual y abrir issue de seguimiento sin
revertir el resto.

## Dependencies

- Ninguna. Sólo `bun:test`, `spyOn`, y fetch mocks ya en uso en los specs
  existentes.

## Success Criteria

- [ ] 5 tests nuevos pasan en `bun test` localmente y en CI.
- [ ] Cada test fue commiteado RED primero (demostrable en historia git: un
      commit con test fallando, luego commit verde — o el patrón equivalente
      acordado en `sdd-tasks`).
- [ ] `bun run tsc --noEmit` sigue en `EXIT=0`.
- [ ] El total de cambios cae cómodamente bajo el budget de 400 LOC
      (estimado: 50-100 LOC).
- [ ] La nota documental sobre `hasExtraUsageEnabled` viviendo en
      `OrganizationProfile` queda asentada en el spec (`sdd-spec` phase).
