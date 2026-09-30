// Social fast-path matcher (D35), including the context-aware goodbye rule and negatives.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SOCIAL_LINES } from "./config.js";
import { goodbyeAllowed, matchSocial } from "./social-fast-path.js";

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

describe("declining an offer is not goodbye (live call 01a0f455…)", () => {
  const TICKET_OFFER = "One moment while I check that. Your transaction TXN-9001 is a payout that's currently processing. The estimated arrival date shown in our records has passed. Would you like me to log a ticket for the support team to look into this?";
  const CALLBACK_OFFER = "I'm sorry, I can't confirm that from our support information. I can connect you with a RelayPay support specialist if you'd like.";
  it(`after the ticket offer, "No, thank you." -> declined_offer (call NOT ended)`, () => {
    assert.equal(matchSocial("No, thank you.", TICKET_OFFER), "declined_offer");
    assert.doesNotMatch(SOCIAL_LINES.declined_offer, /goodbye/i); // the end-call phrase is never spoken
  });
  for (const t of ["No thanks.", "No.", "I'm good.", "Nah, I'm good, thanks."]) {
    it(`"${t}" after the ticket offer -> declined_offer`, () => assert.equal(matchSocial(t, TICKET_OFFER), "declined_offer"));
  }
  it(`"No, thank you." after an offer without a question mark -> declined_offer`, () => assert.equal(matchSocial("No, thank you.", CALLBACK_OFFER), "declined_offer"));
  it(`after "anything else?", "No, thank you." -> goodbye`, () => assert.equal(matchSocial("No, thank you.", ANYTHING_ELSE), "goodbye"));
  it(`after the declined_offer line (which asks "anything else?"), "No, thank you." -> goodbye`, () => assert.equal(matchSocial("No, thank you.", SOCIAL_LINES.declined_offer), "goodbye"));
  it(`a bare "no" with no context -> model`, () => assert.equal(matchSocial("No.", null), null));
  it(`"No, thank you." after a plain statement -> model`, () => assert.equal(matchSocial("No, thank you.", ANSWER), null));
  it(`clear goodbyes still end the call after an offer`, () => {
    assert.equal(matchSocial("No, that's all, thanks.", TICKET_OFFER), "goodbye");
    assert.equal(matchSocial("Thanks, bye!", TICKET_OFFER), "goodbye");
  });
});

describe("goodbyeAllowed (the gate's guard on a model-chosen goodbye)", () => {
  it("allowed right after the fixed 'anything else?' lines", () => {
    assert.equal(goodbyeAllowed("No, thank you.", ANYTHING_ELSE), true);
    assert.equal(goodbyeAllowed("No, thank you.", SOCIAL_LINES.declined_offer), true);
  });
  it("allowed when the caller says goodbye or that they're done", () => {
    assert.equal(goodbyeAllowed("Okay, I'll call back later then, bye.", ANSWER), true);
    assert.equal(goodbyeAllowed("I think that's all for today.", ANSWER), true);
  });
  it("NOT allowed for a decline after an offer, or with no context", () => {
    assert.equal(goodbyeAllowed("No, thank you.", "Would you like me to log a ticket?"), false);
    assert.equal(goodbyeAllowed("No, I don't need a ticket, thanks.", "Would you like me to log a ticket?"), false);
    assert.equal(goodbyeAllowed("No.", null), false);
  });
});
