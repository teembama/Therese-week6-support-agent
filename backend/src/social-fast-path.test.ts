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

describe("the LAST question decides goodbye vs declined_offer (D73, live call 01a0f80f…)", () => {
  const WEATHER = "I can only help with RelayPay account and payment questions. Is there anything else I can help you with regarding RelayPay?";
  it("live: after a model-written 'anything else…?' line, 'No. Thank you.' -> goodbye", () => {
    assert.equal(matchSocial("No. Thank you.", WEATHER), "goodbye");
  });
  it("an offer followed by 'anything else?' -> the last question wins: goodbye", () => {
    assert.equal(matchSocial("No, thanks.", "I can log a ticket if you'd like. Otherwise, is there anything else I can help with?"), "goodbye");
    assert.equal(matchSocial("No.", "Done. I've logged a support ticket for transaction TXN-9004, and our support team will follow up with you. Is there anything else I can help you with?"), "goodbye");
  });
  it("'anything else?' followed by an offer -> the offer is the last question: declined_offer", () => {
    assert.equal(matchSocial("No, thank you.", "Is there anything else I can help you with? Or would you like me to log a ticket?"), "declined_offer");
  });
  it("an offer as the last question -> declined_offer, as before", () => {
    assert.equal(matchSocial("No, thank you.", "Your payout is processing. Would you like me to log a ticket so the team can look into it?"), "declined_offer");
  });
  it("'anything else' that isn't an offer to help (a detail question) -> not goodbye", () => {
    // D90: a detail question isn't an offer either: the model handles the "No." (never goodbye).
    assert.equal(matchSocial("No.", "Is there anything else about this transaction you remember, like the date?"), null);
  });
  it("goodbyeAllowed follows the same rule", () => {
    assert.equal(goodbyeAllowed("No. Thank you.", WEATHER), true);
  });
});

describe("after the off-topic decline line (D78)", () => {
  const OFF_TOPIC = "That's outside what I can help with. I can only help with RelayPay payments and accounts. Is there anything RelayPay-related I can help you with?";
  it("'No thanks' after the off-topic line -> goodbye (it ends with an anything-else question)", () => {
    assert.equal(matchSocial("No thanks.", OFF_TOPIC), "goodbye");
    assert.equal(matchSocial("No, thank you.", OFF_TOPIC), "goodbye");
  });
});

describe("confirmations go to the model; declined_offer only after an offer (D90, live call 01a0fca1…)", () => {
  const READ_BACK = "I have your email as tamara@lagosledger.example. Is that correct?";
  it("the live line: read-back + 'No.' -> the model (null), never declined_offer", () => {
    assert.equal(matchSocial("No.", READ_BACK), null);
    assert.equal(matchSocial("No, it's not.", READ_BACK), null);
    assert.equal(matchSocial("No thanks.", READ_BACK), null);
  });
  it("other confirmation questions -> the model", () => {
    for (const q of ["Thanks, Tamara. I have your email as tamara at lagossledger dot example. Is that correct?", "So that's PAY-7002. Is that right?", "Your name is Efua Mensah. Did I get that right?", "Let me read that back: efua at accra stack dot example. Is that correct?", "Just to confirm, you said tomorrow morning?"]) {
      assert.equal(matchSocial("No.", q), null, q);
    }
  });
  it("offers -> declined_offer", () => {
    for (const q of ["Would you like me to create a support ticket?", "I can connect you with a RelayPay specialist if you'd like.", "I can arrange a callback for you. Would that help?", "Do you want me to raise a ticket for this?"]) {
      assert.equal(matchSocial("No thanks.", q), "declined_offer", q);
    }
  });
  it("a plain question that isn't an offer -> the model", () => {
    assert.equal(matchSocial("No.", "Could I have your name?"), null);
  });
  it("after 'anything else?' a decline is still goodbye", () => {
    assert.equal(matchSocial("No thanks.", "No problem. Is there anything else I can help you with?"), "goodbye");
  });
});
