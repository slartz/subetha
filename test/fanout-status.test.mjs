// The per-member delivery status. Two things are under test and they have different stakes.
//
// The classifier turns an error string into a sentence an owner acts on, and it reads text
// this worker did not write — so what matters is that the ONE failure they will actually hit,
// a forward to an address that is not a verified destination, is named as that and not as
// "unknown". Cloudflare's own wording for it is "destination address not verified".
//
// The shaping decides what a member row draws at all, and its important case is the boring
// one: a member nothing has been sent to yet has no status, and must not be drawn as broken.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFanoutError, withMemberStatus } from "../src/fanout-status.js";

const KINDS = new Set(["unverified_destination", "quota", "rejected", "transient", "unknown"]);
const VERIFY_HINT =
  "This address is not a verified destination on the account: verify it in Email Routing, or switch this member to send.";

test("an unverified destination is named, in Cloudflare's wording and in the loose ones", () => {
  for (const e of [
    "destination address not verified",
    "Destination address not verified",
    "could not forward: destination address is not a verified address",
    "the destination address has not been verified",
    "DESTINATION ADDRESS NOT ALLOWED",
    "destination is not permitted for this account",
  ]) assert.equal(classifyFanoutError("forward", e).kind, "unverified_destination", e);
});

test("the unverified hint tells a forward member's owner the two ways out", () => {
  const { kind, hint } = classifyFanoutError("forward", "destination address not verified");
  assert.equal(kind, "unverified_destination");
  assert.equal(hint, VERIFY_HINT);
});

test("the same kind in send mode points at the binding, not at Email Routing", () => {
  const { kind, hint } = classifyFanoutError("send", "destination address not allowed by the binding");
  assert.equal(kind, "unverified_destination");
  assert.notEqual(hint, VERIFY_HINT, "a send member cannot fix this in Email Routing");
  assert.match(hint, /binding|forward/);
});

test("quota and rate-limit wording is quota, in both modes", () => {
  for (const mode of ["forward", "send"])
    for (const e of [
      "daily sending quota exceeded",
      "Rate limited, try later",
      "rate-limit reached for this account",
      "429 too many requests",
      "you have hit the sending limit",
      "request throttled",
    ]) assert.equal(classifyFanoutError(mode, e).kind, "quota", mode + ": " + e);
});

test("a 5xx is permanent, a 4xx or a timeout is not, in both modes", () => {
  for (const mode of ["forward", "send"]) {
    for (const e of [
      "550 5.1.1 unknown recipient",
      "the server rejected the message",
      "permanent failure delivering to the host",
      "554 transaction failed",
    ]) assert.equal(classifyFanoutError(mode, e).kind, "rejected", mode + ": " + e);
    for (const e of [
      "451 4.7.1 greylisted, try again later",
      "connection timed out",
      "temporary failure, please retry",
      "network error while connecting",
      "socket hang up",
    ]) assert.equal(classifyFanoutError(mode, e).kind, "transient", mode + ": " + e);
  }
});

test("an error that says nothing is unknown rather than guessed at", () => {
  for (const mode of ["forward", "send"])
    for (const e of ["", null, undefined, "something went wrong", "Error"])
      assert.equal(classifyFanoutError(mode, e).kind, "unknown", mode + ": " + String(e));
});

test("every kind comes with exactly one short sentence to act on", () => {
  for (const mode of ["forward", "send", "skip", null])
    for (const e of [
      "destination address not verified", "quota exceeded", "550 no", "timed out", "eh?",
    ]) {
      const { kind, hint } = classifyFanoutError(mode, e);
      assert.ok(KINDS.has(kind), kind);
      assert.ok(hint && hint.length > 20 && hint.length < 200, kind + ": " + hint);
      assert.equal(hint.split(". ").length, 1, "one sentence: " + hint);
    }
});

// ---- shaping -------------------------------------------------------------

const box = (members, member_status) => ({ address: "support@example.com", display_name: "Support", members, member_status });

test("a member nothing has been sent to yet has no status at all", () => {
  const out = withMemberStatus(box(
    [{ email: "new@example.com", mode: "forward" }],
    [{ email: "new@example.com", mode: null, ok: null, error: null, at: null, message_row: null }]));
  assert.deepEqual(out.members, [{ email: "new@example.com", mode: "forward", last: null }]);
});

test("a delivered member carries the time and no hint", () => {
  const out = withMemberStatus(box(
    [{ email: "a@example.com", mode: "send" }],
    [{ email: "a@example.com", mode: "send", ok: 1, error: null, at: 1757000000000, message_row: 7 }]));
  assert.deepEqual(out.members[0].last,
    { mode: "send", ok: true, error: null, at: 1757000000000, message_row: 7, kind: null, hint: null });
});

test("a failed member carries the raw error AND the classification", () => {
  const out = withMemberStatus(box(
    [{ email: "b@example.com", mode: "forward" }],
    [{ email: "b@example.com", mode: "forward", ok: 0, error: "destination address not verified", at: 1757000000001, message_row: 9 }]));
  const last = out.members[0].last;
  assert.equal(last.ok, false);
  assert.equal(last.error, "destination address not verified", "the raw text is never replaced by the hint");
  assert.equal(last.kind, "unverified_destination");
  assert.equal(last.hint, VERIFY_HINT);
  assert.equal(last.message_row, 9, "the row that failed, so the owner can open it");
});

test("a skip is recorded as a skip and never as a delivery", () => {
  const out = withMemberStatus(box(
    [{ email: "c@example.com", mode: "forward" }],
    [{ email: "c@example.com", mode: "skip", ok: 1, error: "skipped: member is the mailbox itself", at: 1757000000002, message_row: 3 }]));
  assert.equal(out.members[0].last.mode, "skip");
  assert.equal(out.members[0].last.ok, true);
  assert.equal(out.members[0].last.hint, null, "a skip is not a failure and has nothing to fix");
});

test("status is matched by address, lowercased, and the raw array does not go on the wire", () => {
  const out = withMemberStatus(box(
    [{ email: "mixed@example.com", mode: "forward" }, { email: "none@example.com", mode: "send" }],
    [
      { email: "MIXED@Example.com", mode: "forward", ok: 0, error: "550 nope", at: 1757000000003, message_row: 1 },
      { email: "removed@example.com", mode: "send", ok: 1, error: null, at: 1757000000004, message_row: 2 },
    ]));
  assert.equal(out.members[0].last.kind, "rejected");
  assert.equal(out.members[1].last, null, "a member with no row of its own gets nothing");
  assert.equal("member_status" in out, false, "the zipped-in array is not part of the response");
  assert.equal(out.address, "support@example.com", "the rest of the mailbox row is untouched");
  assert.equal(out.display_name, "Support");
});

test("a mailbox with no members, and a missing status array, shape to something drawable", () => {
  assert.deepEqual(withMemberStatus(box([], [])).members, []);
  assert.deepEqual(withMemberStatus({ address: "a@b.co" }).members, []);
  assert.deepEqual(withMemberStatus(null).members, []);
  assert.deepEqual(withMemberStatus({ members: [{ email: "x@y.co", mode: "send" }] }).members,
    [{ email: "x@y.co", mode: "send", last: null }]);
});
