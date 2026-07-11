import { test, expect, describe } from "bun:test"

import { dayStartUtcIso, dayEndUtcIso } from "../src/ui/src/lib/date-range"
import { parseDateOnly } from "../src/ui/src/routes/sessions"

const DASHBOARD_TIMEZONE = "America/Santiago"

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

function isoDateFromUtcDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

function datesInRange(startIso: string, endIso: string): string[] {
  const [sy, sm, sd] = startIso.split("-").map(Number)
  const [ey, em, ed] = endIso.split("-").map(Number)
  const end = Date.UTC(ey, em - 1, ed)
  const dates: string[] = []
  for (let t = Date.UTC(sy, sm - 1, sd); t <= end; t += 24 * 3_600_000) {
    dates.push(isoDateFromUtcDate(new Date(t)))
  }
  return dates
}

/**
 * Offset (in whole hours, e.g. -3 or -4) of `DASHBOARD_TIMEZONE` in effect
 * during the afternoon (UTC 15:00, safely away from any midnight transition
 * instant) of the given calendar day. Used only to DISCOVER where the real
 * 2026 DST transitions fall — deliberately not hardcoded, since Chile's DST
 * rules/dates have changed historically.
 */
function offsetHoursOnCalendarDay(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number)
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DASHBOARD_TIMEZONE,
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(Date.UTC(y, m - 1, d, 15, 0, 0)))
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? ""
  const match = /GMT([+-]\d+)/.exec(tzName)
  if (!match) throw new Error(`could not parse offset from "${tzName}" for ${dateStr}`)
  return Number(match[1])
}

/**
 * Scans a wide window of 2026 calendar days (March-May and September-
 * November, covering both possible Southern-hemisphere transition seasons)
 * for the day `DASHBOARD_TIMEZONE`'s UTC offset becomes MORE negative
 * (e.g. -3 -> -4) — the "fall back" transition where a local wall-clock
 * hour repeats. Returns the calendar day whose local 23:00-23:59 hour
 * repeats (`dayBefore`), the following day (`dayAfter`), and the whole-hour
 * offsets in effect on each side of the transition.
 */
function findFallBackTransition(): {
  dayBefore: string
  dayAfter: string
  offsetBeforeHours: number
  offsetAfterHours: number
} {
  const candidates = [
    ...datesInRange("2026-03-01", "2026-05-31"),
    ...datesInRange("2026-09-01", "2026-11-30"),
  ]
  let prevOffset = offsetHoursOnCalendarDay(candidates[0])
  for (let i = 1; i < candidates.length; i++) {
    const offset = offsetHoursOnCalendarDay(candidates[i])
    if (offset < prevOffset) {
      return {
        dayBefore: candidates[i - 1],
        dayAfter: candidates[i],
        offsetBeforeHours: prevOffset,
        offsetAfterHours: offset,
      }
    }
    prevOffset = offset
  }
  throw new Error("No fall-back DST transition found in the scanned 2026 ranges")
}

/**
 * Builds the expected UTC ISO instant for a local wall-clock time under a
 * KNOWN, explicit whole-hour offset — independent of `date-range.ts`'s own
 * offset-resolution logic, so it can serve as a ground truth to check that
 * logic against.
 */
function expectedUtcIso(
  dateStr: string,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  offsetHours: number,
): string {
  const [y, mo, d] = dateStr.split("-").map(Number)
  return new Date(Date.UTC(y, mo - 1, d, hour, minute, second, ms) - offsetHours * 3_600_000).toISOString()
}

describe("dayStartUtcIso / dayEndUtcIso (America/Santiago, DST-aware)", () => {
  test("Chilean winter/standard time (UTC-4, no DST) — 2026-07-11", () => {
    // America/Santiago is UTC-4 in July (Southern-hemisphere winter, no DST).
    // Local midnight 2026-07-11T00:00:00-04:00 == 2026-07-11T04:00:00.000Z.
    expect(dayStartUtcIso("2026-07-11")).toBe("2026-07-11T04:00:00.000Z")
    // Local 23:59:59.999-04:00 == 2026-07-12T03:59:59.999Z.
    expect(dayEndUtcIso("2026-07-11")).toBe("2026-07-12T03:59:59.999Z")
  })

  test("Chilean summer/DST time (UTC-3) — 2026-01-15 — different UTC hour than winter", () => {
    // America/Santiago is UTC-3 in January (Southern-hemisphere summer, DST).
    // Local midnight 2026-01-15T00:00:00-03:00 == 2026-01-15T03:00:00.000Z.
    expect(dayStartUtcIso("2026-01-15")).toBe("2026-01-15T03:00:00.000Z")
    expect(dayEndUtcIso("2026-01-15")).toBe("2026-01-16T02:59:59.999Z")

    // The whole point: DST vs standard time must NOT produce the same UTC
    // hour-of-day for local midnight. A naive hardcoded `-04:00` offset would
    // make this test fail because it would give the same hour as winter.
    const winterStartHour = new Date(dayStartUtcIso("2026-07-11")).getUTCHours()
    const summerStartHour = new Date(dayStartUtcIso("2026-01-15")).getUTCHours()
    expect(summerStartHour).not.toBe(winterStartHour)
  })

  test("dayEndUtcIso is exactly 23:59:59.999 after dayStartUtcIso in local wall-clock terms", () => {
    for (const date of ["2026-07-11", "2026-01-15"]) {
      const startMs = new Date(dayStartUtcIso(date)).getTime()
      const endMs = new Date(dayEndUtcIso(date)).getTime()
      // 23h59m59s999ms in milliseconds.
      expect(endMs - startMs).toBe(23 * 3_600_000 + 59 * 60_000 + 59_000 + 999)
    }
  })

  test("DST fall-back day: the ambiguous last local hour resolves to its LATER (standard-time) occurrence", () => {
    const { dayBefore, dayAfter, offsetBeforeHours, offsetAfterHours } = findFallBackTransition()

    // `dayBefore`'s local midnight is many hours from the transition (which
    // lands at local 24:00), so it's unambiguous and must use the offset
    // still in effect at the start of that day.
    expect(dayStartUtcIso(dayBefore)).toBe(
      expectedUtcIso(dayBefore, 0, 0, 0, 0, offsetBeforeHours),
    )

    // `dayBefore`'s local 23:59:59.999 is the AMBIGUOUS instant: it occurs
    // once under the pre-transition offset and once more, an hour later,
    // under the post-transition offset. The fix must resolve to the LATER
    // (post-transition) occurrence so the query window is never short by an
    // hour of real data. Before the fix, the single-offset-sample technique
    // always resolved to the EARLIER occurrence instead (using
    // `offsetBeforeHours`), silently excluding real request timestamps that
    // fall in the true final hour of `dayBefore`.
    expect(dayEndUtcIso(dayBefore)).toBe(
      expectedUtcIso(dayBefore, 23, 59, 59, 999, offsetAfterHours),
    )

    // `dayAfter`'s local midnight occurs strictly after the transition, so
    // it must use the post-transition offset too.
    expect(dayStartUtcIso(dayAfter)).toBe(
      expectedUtcIso(dayAfter, 0, 0, 0, 0, offsetAfterHours),
    )

    // Sanity: with both boundaries correctly resolved, they must be
    // perfectly contiguous (no gap, no overlap) — and the fall-back day's
    // true elapsed span (containing its repeated hour) must exceed an
    // ordinary day's 23h59m59.999s.
    const startOfDayBefore = new Date(dayStartUtcIso(dayBefore)).getTime()
    const endOfDayBefore = new Date(dayEndUtcIso(dayBefore)).getTime()
    const startOfDayAfter = new Date(dayStartUtcIso(dayAfter)).getTime()
    expect(startOfDayAfter - endOfDayBefore).toBe(1)
    const ordinaryDayLengthMs = 23 * 3_600_000 + 59 * 60_000 + 59_000 + 999
    expect(endOfDayBefore - startOfDayBefore).toBeGreaterThan(ordinaryDayLengthMs)
  })
})

describe("parseDateOnly (calendar-validity guard, routes/sessions.tsx)", () => {
  test("accepts real calendar dates, including a genuine leap day", () => {
    expect(parseDateOnly("2026-07-11")).toBe("2026-07-11")
    expect(parseDateOnly("2026-01-15")).toBe("2026-01-15")
    expect(parseDateOnly("2024-02-29")).toBe("2024-02-29") // 2024 IS a leap year
  })

  test("rejects calendar-invalid dates instead of letting Date.UTC silently roll them over", () => {
    for (const invalid of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-01", "2026-04-31"]) {
      expect(parseDateOnly(invalid)).toBeUndefined()
    }
  })

  test("still rejects shape-invalid input and non-strings (unchanged contract, never throws)", () => {
    expect(parseDateOnly("not-a-date")).toBeUndefined()
    expect(parseDateOnly("2026/07/11")).toBeUndefined()
    expect(parseDateOnly(undefined)).toBeUndefined()
    expect(parseDateOnly(123)).toBeUndefined()
  })
})
