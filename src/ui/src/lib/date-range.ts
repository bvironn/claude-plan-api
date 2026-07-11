/**
 * Day-boundary helpers for the sessions date-range filter.
 *
 * `from`/`to` arrive as plain `YYYY-MM-DD` from `<input type="date">`, but
 * the backend compares them lexically against full ISO timestamps stored in
 * UTC. Widening a bare date to full-day UTC bounds naively (`T00:00:00.000Z`)
 * is wrong for any timezone other than UTC — it would filter by UTC-day
 * boundaries instead of the operator's local day.
 *
 * This dashboard has exactly one operator, based in Chile, so the timezone
 * is hardcoded to `America/Santiago` rather than made configurable or
 * auto-detected from the browser (explicit product decision).
 *
 * Chile's DST offset is NOT a fixed number: it swings between UTC-3 (DST,
 * roughly Sept-Apr) and UTC-4 (standard time, roughly Apr-Sept), and the
 * exact transition dates have changed historically. Hardcoding a numeric
 * offset like `-04:00` would silently produce wrong bounds for half the
 * year. Instead we ask the environment's ICU/IANA tz data (via `Intl`,
 * which JavaScriptCore/Bun ships in full) what the offset is for the
 * specific calendar date in question.
 */

const DASHBOARD_TIMEZONE = "America/Santiago"

const ZONE_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: DASHBOARD_TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
})

/**
 * Offset (in ms) of `DASHBOARD_TIMEZONE` from UTC at the given UTC instant,
 * expressed as `local - utc` (negative west of UTC, e.g. ~-4h or -3h for
 * Santiago). Standard "format a UTC guess, diff against the guess" technique
 * — it's the offset that was in effect at `utcMs`, which is what we need
 * since Santiago's offset itself changes across the DST transition.
 */
function offsetMsAt(utcMs: number): number {
  const parts = ZONE_PARTS_FORMATTER.formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  )
  return asUtc - utcMs
}

// Two real-world DST transitions are always many months apart, so a 2-day
// margin is comfortably enough to land firmly on ONE side of any transition
// that might be near the target date without ever risking crossing into a
// *different*, neighboring transition.
const BRACKET_MARGIN_MS = 2 * 24 * 3_600_000

/**
 * Convert a local wall-clock time (`YYYY-MM-DD` + h/m/s/ms) in
 * `DASHBOARD_TIMEZONE` into the true UTC instant it represents.
 *
 * Near a DST transition, a given wall-clock time can be AMBIGUOUS (fall-back:
 * the local hour repeats, e.g. `23:00-23:59` occurs once under DST and once
 * more under standard time) or NONEXISTENT (spring-forward: the local hour is
 * skipped entirely). A naive "guess the offset once, from the guess itself"
 * technique is not just imprecise for those two cases — it can ALSO silently
 * mis-resolve wall-clock times that aren't ambiguous at all: if the naive
 * guess (numbers-reinterpreted-as-UTC) happens to land on the wrong side of
 * a nearby transition, sampling the offset there can return an offset that
 * doesn't actually apply to the requested wall-clock time.
 *
 * To resolve this robustly we sample the zone's offset comfortably BEFORE
 * and AFTER the target instant (`BRACKET_MARGIN_MS` margin), giving the (at
 * most two) offsets that could plausibly apply. For each, we build a
 * candidate UTC instant and verify it round-trips: re-sampling the offset AT
 * that candidate instant must reproduce the offset used to build it — that
 * is the only way to confirm a candidate is a genuine representation of the
 * requested wall-clock time (see the two constructed-and-verified
 * `candBefore`/`candAfter` below).
 *
 * - Exactly one candidate round-trips → unambiguous, return it.
 * - Both round-trip → genuine ambiguity (repeated hour): both are valid
 *   representations of the SAME wall-clock time, so `preferLater` picks
 *   between them.
 * - Neither round-trips → the wall-clock time was skipped entirely (gap);
 *   `preferLater` picks a reasonable fallback rather than throwing.
 *
 * Per product policy (personal single-user dashboard filter), when in doubt
 * we bias toward slight OVER-inclusion rather than ever silently excluding
 * real data: `dayStartUtcIso` resolves ambiguity to the EARLIER instant,
 * `dayEndUtcIso` to the LATER instant — widening the window rather than
 * narrowing it.
 */
function zonedWallClockToUtcMs(
  dateStr: string,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  preferLater: boolean,
): number {
  const [year, month, day] = dateStr.split("-").map(Number)
  // Deliberately whole-seconds only (no `ms`) here, and for every
  // `offsetMsAt` call below: `formatToParts` has no sub-second field, so
  // folding `ms` into any of these instants would make it drop out of the
  // diff in `offsetMsAt` and silently corrupt the offset by up to 999ms —
  // exactly the bug that broke `dayEndUtcIso`'s `:59.999` bound. `ms` is
  // folded back in only once, at the very end, after the whole-second
  // instant has been fully resolved.
  const targetSec = Date.UTC(year, month - 1, day, hour, minute, second)

  const offsetBefore = offsetMsAt(targetSec - BRACKET_MARGIN_MS)
  const offsetAfter = offsetMsAt(targetSec + BRACKET_MARGIN_MS)

  const candBefore = targetSec - offsetBefore
  const candAfter = targetSec - offsetAfter

  const validBefore = offsetMsAt(candBefore) === offsetBefore
  const validAfter = offsetMsAt(candAfter) === offsetAfter

  let resultSec: number
  if (validBefore && !validAfter) {
    resultSec = candBefore
  } else if (validAfter && !validBefore) {
    resultSec = candAfter
  } else if (validBefore && candBefore === candAfter) {
    // Both agree (far from any transition) — the common case.
    resultSec = candBefore
  } else {
    // Either both round-trip (genuine ambiguity: repeated hour) or neither
    // does (skipped hour). Either way, pick per the over-inclusion policy.
    resultSec = preferLater ? Math.max(candBefore, candAfter) : Math.min(candBefore, candAfter)
  }

  return resultSec + ms
}

/** UTC ISO instant of local midnight (`00:00:00.000`) of `dateStr` in `DASHBOARD_TIMEZONE`. */
export function dayStartUtcIso(dateStr: string): string {
  return new Date(zonedWallClockToUtcMs(dateStr, 0, 0, 0, 0, false)).toISOString()
}

/** UTC ISO instant of local end-of-day (`23:59:59.999`) of `dateStr` in `DASHBOARD_TIMEZONE`. */
export function dayEndUtcIso(dateStr: string): string {
  return new Date(zonedWallClockToUtcMs(dateStr, 23, 59, 59, 999, true)).toISOString()
}
