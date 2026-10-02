// D97: callback time parsing and slot rules (chrono-node, Lagos time, forward-dated).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inPartOfDay, isValidSlot, lagosParts, parseCallbackTime, refusalMessage, slotForSpeech, slotForStaff } from "./tools/callback-slot.js";

const FRI_EVENING = new Date("2026-10-02T17:05:00Z"); // Friday 2 Oct 2026, 18:05 WAT
const MON_MORNING = new Date("2026-10-05T07:00:00Z"); // Monday 5 Oct 2026, 08:00 WAT
const lagos = (d: Date) => { const p = lagosParts(d); return `${p.weekday} ${String(Math.floor(p.minutes / 60)).padStart(2, "0")}:${String(p.minutes % 60).padStart(2, "0")}`; };

describe("callback time parsing (D97)", () => {
  it("'Monday at 10 AM' -> the next Monday, 10:00 Lagos", () => {
    const r = parseCallbackTime("Monday at 10 AM", FRI_EVENING);
    assert.ok(r.ok);
    assert.equal(r.ok && r.slot.toISOString(), "2026-10-05T09:00:00.000Z");
    assert.equal(r.ok && slotForSpeech(r.slot), "Monday 5 October at 10 AM");
  });
  it("'9am tomorrow' on a Friday -> Saturday -> refused: weekend", () => {
    assert.deepEqual(parseCallbackTime("9am tomorrow", FRI_EVENING), { ok: false, reason: "weekend" });
  });
  it("'next Tuesday 2:30pm' -> a Tuesday at 14:30, in the future", () => {
    const r = parseCallbackTime("next Tuesday 2:30pm", FRI_EVENING);
    assert.ok(r.ok);
    assert.equal(r.ok && lagos(r.slot), "2 14:30");
    assert.ok(r.ok && r.slot.getTime() > FRI_EVENING.getTime());
    assert.equal(r.ok && slotForSpeech(r.slot).endsWith("at 2:30 PM"), true);
  });
  it("'5pm' -> outside hours (the last slot is 16:30)", () => {
    assert.deepEqual(parseCallbackTime("5pm", FRI_EVENING), { ok: false, reason: "outside_hours" });
    assert.deepEqual(parseCallbackTime("Monday at 8am", FRI_EVENING), { ok: false, reason: "outside_hours" });
  });
  it("'tomorrow morning' -> needs a specific time (part of day: morning)", () => {
    const r = parseCallbackTime("tomorrow morning", FRI_EVENING);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "needs_specific_time");
    assert.equal(!r.ok && r.partOfDay, "morning");
    assert.equal(parseCallbackTime("Monday afternoon", FRI_EVENING).ok, false);
    assert.equal(parseCallbackTime("Monday", FRI_EVENING).ok, false);
  });
  it("a past time -> past (also less than 30 minutes ahead)", () => {
    assert.deepEqual(parseCallbackTime("today at 10am", FRI_EVENING), { ok: false, reason: "past" });
    // Monday 09:10 now: the 09:30 slot is only 20 minutes ahead (less than 30).
    assert.deepEqual(parseCallbackTime("today at 9:30am", new Date("2026-10-05T08:10:00Z")), { ok: false, reason: "past" });
  });
  it("'16:30' -> valid (the last slot)", () => {
    const r = parseCallbackTime("16:30", MON_MORNING);
    assert.ok(r.ok);
    assert.equal(r.ok && lagos(r.slot), "1 16:30");
  });
  it("'4:45' -> not a slot (16:45 is 15 minutes from the nearest slot); '4:30' said on Monday morning -> Monday 16:30", () => {
    assert.deepEqual(parseCallbackTime("4:45", MON_MORNING), { ok: false, reason: "not_a_slot" });
    const r = parseCallbackTime("4:30", MON_MORNING);
    assert.equal(r.ok && lagos(r.slot), "1 16:30");
    assert.deepEqual(parseCallbackTime("Monday at 8:45am", FRI_EVENING), { ok: false, reason: "outside_hours" });
    const r2 = parseCallbackTime("Monday at 8:55am", FRI_EVENING);
    assert.equal(r2.ok && lagos(r2.slot), "1 09:00");
  });
  it("rounds to the nearest slot only within 10 minutes", () => {
    const r = parseCallbackTime("Monday at 10:05am", FRI_EVENING);
    assert.equal(r.ok && lagos(r.slot), "1 10:00");
    const r2 = parseCallbackTime("Monday at 10:22am", FRI_EVENING);
    assert.equal(r2.ok && lagos(r2.slot), "1 10:30");
    assert.deepEqual(parseCallbackTime("Monday at 10:15am", FRI_EVENING), { ok: false, reason: "not_a_slot" });
  });
  it("nonsense -> needs a specific time", () => {
    assert.equal(!parseCallbackTime("whenever suits you", FRI_EVENING).ok && (parseCallbackTime("whenever suits you", FRI_EVENING) as { reason: string }).reason, "needs_specific_time");
  });
});

describe("slot rules and formatting (D97)", () => {
  it("valid slots: weekday, 09:00-16:30 Lagos, :00/:30", () => {
    assert.equal(isValidSlot(new Date("2026-10-05T08:00:00Z")), true); // Mon 09:00
    assert.equal(isValidSlot(new Date("2026-10-05T15:30:00Z")), true); // Mon 16:30
    assert.equal(isValidSlot(new Date("2026-10-05T16:00:00Z")), false); // Mon 17:00
    assert.equal(isValidSlot(new Date("2026-10-03T09:00:00Z")), false); // Sat
    assert.equal(isValidSlot(new Date("2026-10-05T09:15:00Z")), false); // :15
  });
  it("speech and staff formats (Lagos time)", () => {
    assert.equal(slotForSpeech(new Date("2026-10-05T13:30:00Z")), "Monday 5 October at 2:30 PM");
    assert.equal(slotForStaff(new Date("2026-10-05T09:00:00Z")), "Mon 5 Oct, 10:00 WAT");
  });
  it("parts of the day; refusal messages", () => {
    assert.equal(inPartOfDay(new Date("2026-10-05T09:00:00Z"), "morning"), true);
    assert.equal(inPartOfDay(new Date("2026-10-05T12:00:00Z"), "morning"), false);
    assert.equal(inPartOfDay(new Date("2026-10-05T12:00:00Z"), "afternoon"), true);
    assert.match(refusalMessage("weekend"), /weekend/);
    assert.match(refusalMessage("needs_specific_time", "morning"), /specific time in the morning/);
  });
});
