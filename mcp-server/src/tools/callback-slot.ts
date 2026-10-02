// Callback slot parsing and rules (D97). Deterministic and server-side: the caller's words are
// parsed with chrono-node (pinned) relative to the current Lagos time, forward-dated ("Monday" =
// the next Monday). Pure functions, unit-tested in callback-slot.test.ts.
//
// Rules: Monday-Friday, 09:00-16:30 Africa/Lagos (WAT, UTC+1, no DST), 30-minute slots; at least
// 30 minutes ahead; an explicit time is required ("morning" is too vague); a time is rounded to the
// nearest slot only if it is within 10 minutes of it. Public holidays are out of scope.

import * as chrono from "chrono-node";

export const LAGOS_OFFSET_MINUTES = 60; // WAT, UTC+1, no daylight saving
export const SLOT_MINUTES = 30;
export const MIN_LEAD_MINUTES = 30;
export const ROUND_WITHIN_MINUTES = 10;
export const FIRST_SLOT = 9 * 60; // 09:00
export const LAST_SLOT = 16 * 60 + 30; // 16:30
export const BUSINESS_HOURS_SENTENCE = "Callbacks are available Monday to Friday, 9 AM to 5 PM Lagos time.";

export type RefusalReason = "weekend" | "outside_hours" | "past" | "taken" | "needs_specific_time" | "not_a_slot";
export type PartOfDay = "morning" | "afternoon";
export type ParseOutcome =
  | { ok: true; slot: Date }
  | { ok: false; reason: Exclude<RefusalReason, "taken">; partOfDay?: PartOfDay; day?: Date };

/** Lagos wall-clock parts of an instant. */
export function lagosParts(d: Date): { year: number; month: number; day: number; weekday: number; minutes: number } {
  const l = new Date(d.getTime() + LAGOS_OFFSET_MINUTES * 60_000);
  return { year: l.getUTCFullYear(), month: l.getUTCMonth(), day: l.getUTCDate(), weekday: l.getUTCDay(), minutes: l.getUTCHours() * 60 + l.getUTCMinutes() };
}

/** The instant for a Lagos wall-clock date and minutes since midnight. */
export function lagosInstant(year: number, month: number, day: number, minutes: number): Date {
  return new Date(Date.UTC(year, month, day, 0, minutes) - LAGOS_OFFSET_MINUTES * 60_000);
}

/** A valid slot instant: a weekday, 09:00-16:30 Lagos, on :00 or :30, no seconds. */
export function isValidSlot(d: Date): boolean {
  const p = lagosParts(d);
  return p.weekday >= 1 && p.weekday <= 5 && p.minutes >= FIRST_SLOT && p.minutes <= LAST_SLOT && p.minutes % SLOT_MINUTES === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

const MORNING = /\b(morning|a\.?m\.? sometime|early)\b/i;
const AFTERNOON = /\b(afternoon|after lunch|evening|later today|end of the day)\b/i;

/**
 * Parses the caller's words into a slot, or the reason it can't be one. Order: a vague time (no
 * explicit time) -> the time of day (outside hours / not a slot) -> the day (weekend) -> the past.
 */
export function parseCallbackTime(text: string, now: Date): ParseOutcome {
  const result = chrono.parse(text, { instant: now, timezone: LAGOS_OFFSET_MINUTES }, { forwardDate: true })[0];
  const partOfDay: PartOfDay | undefined = MORNING.test(text) ? "morning" : AFTERNOON.test(text) ? "afternoon" : undefined;
  if (!result || !result.start.isCertain("hour")) {
    const day = result?.start.date();
    return { ok: false, reason: "needs_specific_time", ...(partOfDay ? { partOfDay } : {}), ...(day && (result?.start.isCertain("day") || result?.start.isCertain("weekday")) ? { day } : {}) };
  }
  const start = result.start;
  let when = start.date();
  // No AM/PM given ("4:45"): in a 9-to-5 calendar, 1-7 o'clock means the afternoon.
  if (!start.isCertain("meridiem")) {
    const h = lagosParts(when).minutes / 60;
    if (h >= 1 && h < 8) {
      when = new Date(when.getTime() + 12 * 3_600_000);
      // forwardDate may have moved an already-passed morning hour to tomorrow; the afternoon of
      // the same day can still be ahead ("4:45" said at 08:00 on Monday = Monday 16:45).
      const sameDay = new Date(when.getTime() - 24 * 3_600_000);
      if (!start.isCertain("day") && !start.isCertain("weekday") && sameDay.getTime() > now.getTime()) when = sameDay;
    }
  }
  const p = lagosParts(when);
  // Outside hours: before 08:50 or from 17:00 (the business day ends at 5 PM; the last slot is 16:30).
  if (p.minutes < FIRST_SLOT - ROUND_WITHIN_MINUTES || p.minutes >= 17 * 60) return { ok: false, reason: "outside_hours" };
  const nearest = Math.min(LAST_SLOT, Math.max(FIRST_SLOT, Math.round(p.minutes / SLOT_MINUTES) * SLOT_MINUTES));
  if (Math.abs(nearest - p.minutes) > ROUND_WITHIN_MINUTES) return { ok: false, reason: "not_a_slot" };
  const slot = lagosInstant(p.year, p.month, p.day, nearest);
  const sp = lagosParts(slot);
  if (sp.weekday === 0 || sp.weekday === 6) return { ok: false, reason: "weekend" };
  if (slot.getTime() < now.getTime() + MIN_LEAD_MINUTES * 60_000) return { ok: false, reason: "past" };
  return { ok: true, slot };
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Monday 5 October at 10 AM" / "at 2:30 PM" (Lagos time), for speech. */
export function slotForSpeech(d: Date): string {
  const p = lagosParts(d);
  const h = Math.floor(p.minutes / 60), m = p.minutes % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${DAYS[p.weekday]} ${p.day} ${MONTHS[p.month]} at ${h12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

/** "Mon 5 Oct, 10:00 WAT" (Discord, the staff dashboard). */
export function slotForStaff(d: Date): string {
  const p = lagosParts(d);
  return `${SHORT_DAYS[p.weekday]} ${p.day} ${SHORT_MONTHS[p.month]}, ${String(Math.floor(p.minutes / 60)).padStart(2, "0")}:${String(p.minutes % 60).padStart(2, "0")} WAT`;
}

/** Whether a slot is in a part of the day: morning 09:00-11:30, afternoon 12:00-16:30. */
export function inPartOfDay(d: Date, part: PartOfDay | undefined): boolean {
  if (!part) return true;
  const m = lagosParts(d).minutes;
  return part === "morning" ? m < 12 * 60 : m >= 12 * 60;
}

/** The refusal message the agent says in plain words (then the business hours and the offered slots). */
export function refusalMessage(reason: RefusalReason, partOfDay?: PartOfDay): string {
  switch (reason) {
    case "weekend": return "Callbacks can't be booked at the weekend.";
    case "outside_hours": return "That time is outside callback hours.";
    case "past": return "That time has already passed, or is less than 30 minutes from now.";
    case "taken": return "That callback time has just been taken.";
    case "not_a_slot": return "Callbacks are booked on the hour or half hour.";
    case "needs_specific_time": return partOfDay ? `I need a specific time in the ${partOfDay} to book the callback.` : "I need a specific day and time to book the callback.";
  }
}
