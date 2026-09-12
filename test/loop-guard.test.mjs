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
