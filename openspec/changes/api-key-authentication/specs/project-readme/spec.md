# Delta for project-readme

## MODIFIED Requirements

### Requirement: Configuration Accuracy

The Configuration section MUST document every overridable env var in `src/config.ts` with columns name, type, default, purpose. The table MUST include `PORT`, `BIND_HOST`, `CREDENTIALS_PATH`, `ANTHROPIC_CLI_VERSION`, `MAX_RETRY_AFTER_MS`, `REQUIRE_API_KEY`, and `API_KEY_PEPPER`.

(Previously: the mandatory env-var list omitted `REQUIRE_API_KEY` and `API_KEY_PEPPER`, which are added to `src/config.ts` by this change.)

#### Scenario: Env var coverage

- GIVEN `src/config.ts` exposes env var `X`
- WHEN the Configuration table is read
- THEN row `X` exists with non-empty default and purpose cells

## ADDED Requirements

### Requirement: Authentication Documentation

The README MUST document that inbound request authentication now exists: how to issue a key via `scripts/create-api-key.ts`, how to present it (`Authorization: Bearer` or `X-API-Key`), and the `REQUIRE_API_KEY` cutover flag (default `false`). The README MUST NOT retain the stale "not a replacement for a real API key" disclaimer line that implies the gateway has no request authentication; that line MUST be removed or updated to reflect that per-member keys now gate the JSON API.

#### Scenario: Key issuance and usage documented

- GIVEN the published README
- WHEN the Configuration and API documentation are read
- THEN they explain issuing a key via `scripts/create-api-key.ts` and presenting it via `Authorization: Bearer` or `X-API-Key`

#### Scenario: Stale disclaimer line removed

- GIVEN the README Disclaimer and Pitch content
- WHEN the text is inspected
- THEN it contains no line asserting the gateway is "not a replacement for a real API key" in a way that implies zero request authentication
- AND the change modifies only `README.md` for this documentation update
