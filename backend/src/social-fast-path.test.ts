// Social fast-path matcher (D35), including the context-aware goodbye rule and negatives.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SOCIAL_LINES } from "./config.js";
import { matchSocial } from "./social-fast-path.js";

const ANYTHING_ELSE = SOCIAL_LINES.thanks; // "You're welcome. Is there anything else I can help you with?"
const ANSWER = "International payouts usually take 2 to 5 business days, depending on destination and banking partners.";

describe("thanks", () => {
  for (const t of ["Thank you.", "Thanks!", "All right, thank you.", "Okay thanks", "Thank you for helping.", "Great, thanks so much.", "Much appreciated."]) {
    it(`"${t}" -> thanks`, () => assert.equal(matchSocial(t, ANSWER), "thanks"));
  }
});

describe("clear goodbye (no context needed)", () => {
  for (const t of ["Bye.", "Goodbye!", "No, that's all.", "No, nothing else.", "Nothing else, thanks.", "No, nothing else. Thanks.", "Thanks, bye!", "That's all, thank you. Goodbye.", "no thats all"]) {
    it(`"${t}" -> goodbye`, () => assert.equal(matchSocial(t, ANSWER), "goodbye"));
  }
});

describe("short declines right after the backend's 'anything else?' line", () => {
  for (const t of ["No.", "Nah.", "Nope.", "I'm good.", "No, I'm good.", "Nah, I'm good.", "All good.", "That's all.", "Not really.", "No thanks.", "Nothing else.", "No, thank you.", "Thanks, I'm good.", "No, I'm good, thanks.", "im good"]) {
    it(`"${t}" after "anything else?" -> goodbye`, () => assert.equal(matchSocial(t, ANYTHING_ELSE), "goodbye"));
  }
  it("matching of the previous line tolerates Vapi joining sentences without a space", () => {
    assert.equal(matchSocial("No.", "You're welcome.Is there anything else I can help you with?"), "goodbye");
  });
});

describe("NOT the fast path (goes to the model)", () => {
  const cases: Array<[string, string | null, string]> = [
    ["No.", ANSWER, "bare 'no' without the 'anything else?' context"],
    ["No.", null, "bare 'no' as the first message"],
    ["I'm good.", ANSWER, "'I'm good' without context"],
    ["Thanks, and what about fees?", ANSWER, "thanks plus a question"],
    ["Thanks, and what about fees?", ANYTHING_ELSE, "thanks plus a question, even after 'anything else?'"],
    ["No, actually, one more thing.", ANYTHING_ELSE, "decline plus more content"],
    ["No, but what about fees?", ANYTHING_ELSE, "decline plus a question"],
    ["Oh well.", ANYTHING_ELSE, "ambiguous (may signal disappointment)"],
    ["Oh well.", ANSWER, "ambiguous without context"],
    ["All right.", ANSWER, "filler only, no intent"],
    ["Hello?", ANSWER, "greetings stay on the model path"],
    ["Thank you, how long do payouts take?", ANSWER, "thanks plus a question"],
  ];
  for (const [text, prev, why] of cases) it(`"${text}": ${why}`, () => assert.equal(matchSocial(text, prev), null));
});
