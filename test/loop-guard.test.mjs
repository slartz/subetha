// The loop guards. Getting one of these wrong does not produce a bug report, it produces a
// mail loop at machine speed between this worker and somebody else's autoresponder, from a
// domain whose sending reputation everything else on the account depends on. So every
// branch is asserted, including the ones that must NOT fire.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loopReason, memberSkip, parseDomains } from "../src/loop-guard.js";

const H = (o) => new Headers(o);

test("Auto-Submitted suppresses the fan-out, except the one value that means a person", () => {
  assert.equal(loopReason(H({ "auto-submitted": "auto-replied" })), "auto-submitted:auto-replied");
  assert.equal(loopReason(H({ "auto-submitted": "auto-generated" })), "auto-submitted:auto-generated");
  assert.equal(loopReason(H({ "auto-submitted": "auto-notified; owner@example.com" })), "auto-submitted:auto-notified");
  assert.equal(loopReason(H({ "auto-submitted": "no" })), null, "RFC 3834: 'no' means a person sent it");
  assert.equal(loopReason(H({ "auto-submitted": "NO" })), null);
});

test("Precedence suppresses bulk, junk and list, and nothing else", () => {
  assert.equal(loopReason(H({ precedence: "bulk" })), "precedence:bulk");
  assert.equal(loopReason(H({ precedence: "junk" })), "precedence:junk");
  assert.equal(loopReason(H({ precedence: "List" })), "precedence:list");
  assert.equal(loopReason(H({ precedence: "first-class" })), null);
  assert.equal(loopReason(H({ precedence: "normal" })), null);
});

test("X-Subetha-Hop is our own mark and outranks everything", () => {
  assert.equal(loopReason(H({ "x-subetha-hop": "1" })), "x-subetha-hop");
  assert.equal(loopReason(H({ "x-subetha-hop": "1", "auto-submitted": "no" })), "x-subetha-hop");
});

test("an ordinary message is not suppressed", () => {
  assert.equal(loopReason(H({ from: "alice@example.com", subject: "hello" })), null);
  assert.equal(loopReason(H({})), null);
});

test("loopReason reads a plain object as happily as a Headers", () => {
  assert.equal(loopReason({ "x-subetha-hop": "1" }), "x-subetha-hop");
  assert.equal(loopReason({ precedence: "bulk" }), "precedence:bulk");
  assert.equal(loopReason({}), null);
});

test("X-Autoreply and X-Autorespond suppress on their presence alone", () => {
  // These two are on an autoresponder's OWN OUTPUT, which is what makes them guards: the
  // message is already an automatic reply, and a fan-out replies to it five more times.
  // Neither has a value meaning "a person wrote this", the way Auto-Submitted's "no" does.
  assert.equal(loopReason(H({ "x-autoreply": "yes" })), "x-autoreply");
  assert.equal(loopReason(H({ "x-autoreply": "anything at all" })), "x-autoreply");
  assert.equal(loopReason(H({ "x-autorespond": "auto" })), "x-autorespond");
  assert.equal(loopReason({ "x-autorespond": "1" }), "x-autorespond", "a plain object reads the same");
  // An EMPTY value reads as absent, exactly as X-Subetha-Hop does: nothing sends one, and
  // treating a blank as a mark would make an accident of formatting into a suppressed fan-out.
  assert.equal(loopReason(H({ "x-autoreply": "" })), null);
  assert.equal(loopReason(H({ "x-subetha-hop": "" })), null, "the same rule the hop header has always had");
});

test("Auto-Submitted is named before the pre-RFC spellings, and the hop before both", () => {
  assert.equal(loopReason(H({ "auto-submitted": "auto-replied", "x-autoreply": "yes" })),
    "auto-submitted:auto-replied");
  assert.equal(loopReason(H({ "x-subetha-hop": "1", "x-autoreply": "yes" })), "x-subetha-hop");
});

test('"do not auto-reply to me" is NOT "do not forward me"', () => {
  // The question this predicate answers is whether forwarding would go round again, not whether
  // a machine sent it. A shared address exists to receive no-reply registration mail,
  // notifications and receipts, and forwarding one of those to a human member cannot loop — a
  // person is not an autoresponder. Both of these were tried as guards and removed; they are
  // asserted here so the omissions read as decisions rather than as gaps.
  //
  // X-Auto-Response-Suppress is Exchange's, and Exchange puts it on ordinary notification mail.
  assert.equal(loopReason(H({ "x-auto-response-suppress": "All" })), null);
  assert.equal(loopReason(H({ "x-auto-response-suppress": "OOF, AutoReply" })), null);
  // A machine-looking sender is a machine that will not answer back. Forward it.
  for (const local of ["mailer-daemon", "postmaster", "no-reply", "noreply",
                       "do-not-reply", "donotreply", "bounce", "bounces"])
    assert.equal(loopReason(H({ from: `${local}@example.com` })), null,
      `${local}@ is exactly the mail a shared mailbox is for`);
  assert.equal(loopReason(H({ from: "MAILER-DAEMON@mx.example.com (Mail Delivery System)" })), null);
  assert.equal(loopReason(H({ from: '"Mail Delivery Subsystem" <MAILER-DAEMON@mx.example.com>' })), null);
  // A bounce that DOES mark itself is still stopped, by the mark rather than by its address.
  assert.equal(loopReason(H({ from: "mailer-daemon@mx.example.com", "auto-submitted": "auto-generated" })),
    "auto-submitted:auto-generated");
  assert.equal(loopReason(H({ from: "no-reply@example.com", precedence: "bulk" })), "precedence:bulk");
});

test("a send-mode fan-out copy cannot be fanned out again", () => {
  // The headers inbound.js puts on a send-mode copy. Either one alone stops it, which is the
  // point of carrying both: X-Subetha-Hop is ours and an intermediary may drop it,
  // Auto-Submitted is the standard one and a mail system may add to it.
  const copy = { "auto-submitted": "auto-replied", "x-subetha-hop": "1" };
  assert.equal(loopReason(H(copy)), "x-subetha-hop");
  assert.equal(loopReason(H({ "auto-submitted": copy["auto-submitted"] })), "auto-submitted:auto-replied");
  assert.equal(loopReason(H({ "x-subetha-hop": copy["x-subetha-hop"] })), "x-subetha-hop");
});

test("a List-Id is deliberately NOT a guard", () => {
  // A shared mailbox that subscribes to a mailing list is a normal thing to want, and
  // suppressing on List-Id would silently break it. Recorded here so the omission reads as
  // a decision rather than an oversight.
  assert.equal(loopReason(H({ "list-id": "Some List <l.example.com>" })), null);
});

test("a member that is the mailbox itself is skipped", () => {
  assert.equal(memberSkip("support@example.com", "support@example.com", "example.com"), "self");
  assert.equal(memberSkip("SUPPORT@Example.Com", "support@example.com", ""), "self", "case never saves it");
});

test("a member on a domain this worker routes is skipped", () => {
  const routed = parseDomains("example.com, example.org");
  assert.equal(memberSkip("someone@example.com", "support@example.com", routed), "routed-domain");
  assert.equal(memberSkip("someone@EXAMPLE.ORG", "support@example.com", routed), "routed-domain");
  assert.equal(memberSkip("someone@example.net", "support@example.com", routed), null);
});

test("memberSkip takes the raw var as happily as a parsed set", () => {
  assert.equal(memberSkip("x@example.com", "support@example.com", "example.com"), "routed-domain");
  assert.equal(memberSkip("x@example.net", "support@example.com", "example.com"), null);
  assert.equal(memberSkip("x@example.net", "support@example.com", ""), null, "no routed domains configured");
  assert.equal(memberSkip("", "support@example.com", ""), "empty");
});

test("parseDomains: comma separated, trimmed, lowercased, blanks dropped", () => {
  assert.deepEqual([...parseDomains(" A.com , b.CO ,, ")], ["a.com", "b.co"]);
  assert.deepEqual([...parseDomains(null)], []);
});
