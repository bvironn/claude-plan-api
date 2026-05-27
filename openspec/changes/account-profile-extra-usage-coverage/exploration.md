# Exploration: Add coverage + AccountProfile.hasExtraUsageEnabled

> **Slug confirmed**: `account-profile-extra-usage-coverage`
> **Phase**: explore (read-only). No code modified.

## Problem statement

El pedido fue: *"Add coverage + AccountProfile.hasExtraUsageEnabled"*. Eso bundlea dos
cosas en una sola frase, y una de las dos arranca con una premisa rota:

1. **`AccountProfile.hasExtraUsageEnabled`** — Hoy ese campo **NO** vive en
   `AccountProfile`. Vive en `OrganizationProfile`. Y ya está modelado, normalizado
   desde la API de Anthropic (`organization.has_extra_usage_enabled`), serializado
   por `GET /api/account/profile`, y cubierto por tests. Es decir: si la intención
   del usuario es "agregar el campo a `AccountProfile`", hay que decidir antes si
   eso es **hoist/alias** del flag de la organization, **rename del campo**, o una
   **nueva semántica derivada** distinta.
2. **Coverage** — La parte de "coverage" es ambigua. Puede ser (a) agregar tests
   para una nueva incorporación, (b) endurecer los tests existentes del área
   AccountProfile, o (c) configurar coverage tooling en sí
   (`openspec/config.yaml` declara `coverage.available: false`).

Esta exploración mapea el estado real del código, marca la confusión de tipos
arriba con evidencia, y deja al orchestrator/usuario una decisión limpia antes
de pasar a propuesta.

## Codebase findings

### Donde vive el dominio AccountProfile

`src/domain/account.ts:14-22` define hoy:

```ts
export interface AccountProfile {
  uuid: string | null;
  fullName: string | null;
  displayName: string | null;
  email: string | null;
  hasClaudeMax: boolean;
  hasClaudePro: boolean;
  createdAt: string | null;
}
```

**`hasExtraUsageEnabled` NO está acá.** Está en `OrganizationProfile`
(`src/domain/account.ts:24-34`):

```ts
export interface OrganizationProfile {
  uuid: string | null;
  name: string | null;
  organizationType: string | null;
  billingType: string | null;
  rateLimitTier: string | null;
  hasExtraUsageEnabled: boolean;        // <-- vive acá
  subscriptionStatus: string | null;
  subscriptionCreatedAt: string | null;
  claudeCodeTrialEndsAt: string | null;
}
```

Y `FullProfile` (`src/domain/account.ts:42-47`) combina las tres:

```ts
export interface FullProfile {
  account: AccountProfile;
  organization: OrganizationProfile;
  application: ApplicationProfile;
  fetchedAt: string;
}
```

### Cadena de lectura/escritura del flag

- **Origen upstream**: Anthropic `/api/oauth/profile` devuelve
  `organization.has_extra_usage_enabled: boolean`
  (`src/domain/account.ts:148` — normalización con `=== true` estricto).
- **Cache en memoria**: `cachedProfile` + `ensureProfile()` / `refreshProfile()`
  (`src/domain/account.ts:49-79`). Sin persistencia a disco. No hay TTL — se
  cachea hasta que el proceso muere o se llama `refreshProfile()`.
- **HTTP exposure**: `GET /api/account/profile` lo devuelve tal cual
  (`src/http/routes/account.ts:13-35`). Soporta `?refresh=1`.
- **Logging**: `emit("info", "account.profile.fetched", { …, hasExtraUsageEnabled })`
  (`src/domain/account.ts:108-115`).
- **Consumidores del flag dentro del proceso**: **ninguno.** Greppeé
  `extraUsage|hasExtraUsage` en todo `src/` — el único lugar donde aparece es la
  declaración, la normalización, y el log. Nadie lo lee para decidir nada.

### "Extra usage" como concepto en este codebase

`src/upstream/beta-exclusion.ts:15-25` reacciona a errores *string-matched* del
upstream que mencionan "Extra usage":

```ts
responseBody.includes("Extra usage is required for long context requests") ||
responseBody.includes("long context beta is not yet available") ||
responseBody.includes("You're out of extra usage")
```

Significa: cuando el usuario pide 1M-context **sin** extra usage habilitado, o
con su cuota de overage gastada, Anthropic devuelve 4xx con uno de estos
strings, y el proxy reacciona dropeando el beta `context-1m-2025-08-07` para ese
modelo. **El flag `hasExtraUsageEnabled` NO se usa pre-emptivamente para evitar
ese roundtrip** — la decisión es reactiva, post-error.

Eso abre una posibilidad de mejora natural (preflight: si el flag es `false`,
nunca mandar el beta long-context), pero **es scope nuevo**, no algo que el
código de hoy haga y haya que testear.

### Estado de tipos hoy

Corrí `bun run tsc --noEmit` (read-only, justificado por verificar un claim del
archivo `openspec/changes/archive/2026-05-27-sanitize-empty-text-blocks/verify-report.md:18-25`
que afirma "3 errores pre-existentes en `hasExtraUsageEnabled`").

**Resultado**: `EXIT=0`, zero errors. El verify-report está **desactualizado**
respecto del código actual — los errores TS2769/TS2741 que mencionaba ya no
existen. El campo está bien tipado en todos los call sites.

## Coverage gap analysis

### Tests que tocan AccountProfile / extra usage hoy

- **`__tests__/domain-account-profile.spec.ts`** (141 líneas, ~10 tests):
  - Happy path: normalización completa account+org+application
    (líneas 4-83) con un payload "real shape" capturado de un Max real.
  - Defensive coercion: missing objects, tipos raros, `=== true` gating
    explícito para `has_extra_usage_enabled` (líneas 120-129).
  - Forward-compat: extra keys ignoradas silenciosamente.
- **`__tests__/http-routes-account.spec.ts`** (106 líneas, 3 tests):
  - 200 normalizado, `?refresh=1` dispara fetch, 502 cuando upstream falla y
    no hay cache.
  - Mockea `getCredentials` y `globalThis.fetch`.

### Lo que está cubierto

- ✅ Normalización del flag (estricto `=== true`, false defaults, missing org).
- ✅ Roundtrip HTTP del flag (`expect(org.hasExtraUsageEnabled).toBe(false)` en
  el spec del route, línea 77).
- ✅ Edge cases del normalize (numérico, string "true", missing).

### Lo que NO está cubierto

- ❌ **No hay test que vea `hasExtraUsageEnabled: true`** en happy path
  (todos los fixtures usan `false`). Si Anthropic mandara `true`, no hay
  evidencia de que se propague correcto hasta el JSON del response.
- ❌ **No hay test del log emit** (`account.profile.fetched` con
  `hasExtraUsageEnabled`). Si rompemos el shape del log, ningún spec lo
  agarra.
- ❌ **No hay test de cache hit vs miss** explícito para `ensureProfile()` —
  los specs del route asumen `refresh=1` para forzar fetch porque "ES modules
  are cached across tests" (comentario en `http-routes-account.spec.ts:39-41`).
  El comportamiento de cache concurrente (`inflight` dedup,
  `src/domain/account.ts:67-68`) tampoco tiene cobertura directa.
- ❌ **No hay test de interacción** entre el flag y `beta-exclusion.ts`.
  Hoy no hay interacción — pero si el feature es agregarla, hay que
  testearla.

`openspec/config.yaml:25-27` declara `coverage.available: false` con la nota
"bun test has no built-in coverage flag yet; c8/istanbul not configured". O sea
que medir cobertura numéricamente requiere agregar tooling — no es free.

## Open questions / assumptions

Estas las tiene que aclarar el usuario antes de propose. NO las inventes:

1. **¿Qué significa "Add `AccountProfile.hasExtraUsageEnabled`"?**
   - (a) ¿Mover el campo de `OrganizationProfile` a `AccountProfile`? (breaking,
     rompe el shape público de `GET /api/account/profile`).
   - (b) ¿Duplicarlo / aliasarlo en `AccountProfile` por conveniencia para
     consumidores que sólo quieren un objeto "account"? (no breaking, redundante).
   - (c) ¿Es una confusión de nombres y el usuario sabe que ya existe en
     `OrganizationProfile`, y lo que quiere es agregar tests/consumidores?
   - (d) ¿Es una nueva semántica derivada — e.g. "AccountProfile expone un
     flag agregado que combina extra_usage con otros factores"?
2. **¿Qué quiere decir "coverage"?**
   - (a) Tests nuevos para lo que se agregue en (1).
   - (b) Cubrir los huecos listados arriba (happy-path-true, cache, logs).
   - (c) Configurar tooling de coverage en sí (c8/istanbul + threshold) —
     es otra magnitud de scope.
3. **¿El flag se va a usar para preflight (saltar `context-1m-2025-08-07` si
   `hasExtraUsageEnabled === false`)?** Eso es scope nuevo, no exploración —
   pero define si el dominio del cambio queda contenido o se expande.

## Candidate approaches

### Approach A — "Hoist alias to AccountProfile + coverage gap-fill" (recomendado tentativo)

**Qué**: Agregar `hasExtraUsageEnabled: boolean` a `AccountProfile` como
**alias derivado** (lee de `org.has_extra_usage_enabled` en normalize), sin
remover el campo del organization. Una sola fuente de verdad en el payload
upstream; dos lecturas en nuestro shape. Sumar tests para el happy-path-true,
el log emit, y opcionalmente cache hit/miss.

- **Pros**: No rompe `GET /api/account/profile`. Resuelve la confusión de
  nombres dejando el flag accesible desde ambos lugares. Coverage gap-fill es
  bounded y vive en los dos specs ya existentes.
- **Cons**: Redundancia en el shape (dos campos con el mismo valor).
  Riesgo a futuro de desincronización si alguien edita un lado y olvida el otro
  (mitigable con tests).
- **Effort**: Low. ~15-30 LOC en `account.ts`, ~30-60 LOC de tests.

### Approach B — "Coverage-only, keep field on Organization"

**Qué**: Reconocer que el campo ya está bien donde está, NO tocar tipos, y
sólo cerrar los huecos de cobertura (happy-path-true, logs, cache).
Documentar explícitamente que el flag vive en `OrganizationProfile`.

- **Pros**: Cero riesgo de breaking. La menor superficie posible. Honesta con
  la realidad del código.
- **Cons**: Si el usuario realmente quería el campo en `AccountProfile`, no
  resuelve su pedido. Hay que **preguntarle** antes de tomar este camino.
- **Effort**: Very Low. Sólo tests.

### Approach C — "Two changes, split the bundle"

**Qué**: Cortar el cambio en dos:
1. `account-profile-extra-usage-flag` — decide y resuelve la cuestión del
   campo (hoist, rename, o no-op con doc).
2. `account-profile-coverage-hardening` — gap-fill de tests independientes.

- **Pros**: Cada cambio tiene un scope claro, review-friendly. Cumple el
  consejo del review-workload guard (400 LOC budget cómodo).
- **Cons**: Overhead de proceso para algo que probablemente cabe en una sola
  PR < 200 líneas.
- **Effort**: Process Medium, code Low.

### Approach D — "Expand scope: preflight extra-usage gating"

**Qué**: Usar `hasExtraUsageEnabled` en `src/upstream/anthropic-client.ts` o
en una nueva capa de preflight, para evitar mandar el beta
`context-1m-2025-08-07` cuando sabemos que el upstream lo va a rechazar.
Cubrir con tests de integración.

- **Pros**: Le da utilidad real al flag (hoy es un dato muerto dentro del
  proceso). Reduce roundtrips fallidos.
- **Cons**: Scope creep masivo respecto del pedido original. Cambia
  semántica observable. Necesita su propia exploración/propuesta — NO debería
  meterse acá sin orden explícita del usuario.
- **Effort**: Medium-High.

## Suggested scope boundary

**Recomendado: Approach A, en un solo change** — siempre que el usuario confirme
que la intención (1) es alguno de (a)/(b)/(c), no (d). Razones:

- El bundle "campo + tests" es chico, cohesivo, y cabe holgado en 400 LOC.
- Approach C (split) suma proceso sin beneficio claro acá.
- Approach D (preflight gating) es otro feature; merece su propio change si
  alguna vez se decide hacerlo.

Si el usuario aclara que la intención (1) es "el campo ya existe, sólo quiero
tests", caer a **Approach B**.

## Final slug recommendation

**Confirmo `account-profile-extra-usage-coverage`** (37 chars, kebab-case,
captura las dos vertientes — el campo y la cobertura). Si el usuario elige
Approach B, un slug más honesto sería `account-profile-coverage-hardening`,
pero podemos mantener el actual sin pérdida.

## Risks

1. **Ambigüedad del pedido original** — sin clarificar la pregunta 1 de "Open
   questions", cualquier propuesta va a ser una apuesta. Riesgo: gastar ciclos
   en algo que el usuario no pidió.
2. **Verify-report obsoleto induciendo a error** — el archive de
   `sanitize-empty-text-blocks` declara errores TS que hoy no existen.
   Riesgo: futuras fases asumen que hay deuda técnica acá cuando no la hay.
   Mitigación: este exploration lo deja documentado.
3. **Coverage tooling drift** — si "coverage" significa tooling (no tests),
   el scope se sale de mano. Mitigación: forzar disambiguación en propose.
