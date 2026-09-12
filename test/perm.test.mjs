// The permission predicate. It is the only thing standing between a member of ONE mailbox and
// every other mailbox in the zone, so every role gets every answer asserted, including the
// ones that must be NO.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canAdmin, canView, isMember, parseOwners, visibleMailboxes } from "../src/perm.js";

const OWNERS = parseOwners("Owner@Example.com, second@example.com");
const support = { address: "support@example.com", members: [{ email: "member@example.com", mode: "forward" }] };
const bookings = { address: "bookings@example.com", members: [{ email: "other@example.com", mode: "send" }] };

test("parseOwners: comma separated, trimmed, lowercased, blanks dropped", () => {
  assert.deepEqual([...parseOwners(" A@b.CO , c@d.co ,, ")], ["a@b.co", "c@d.co"]);
  assert.deepEqual([...parseOwners(null)], []);
  assert.deepEqual([...parseOwners("")], []);
});

test("an owner may administer, and case never changes the answer", () => {
  assert.equal(canAdmin("owner@example.com", OWNERS), true);
  assert.equal(canAdmin("OWNER@Example.COM", OWNERS), true);
  assert.equal(canAdmin("second@example.com", OWNERS), true);
  assert.equal(canAdmin("owner@example.com", "owner@example.com"), true, "the raw var works too");
});

test("the bearer is owner-equivalent", () => {
  // It is the operator's own automation credential and can already reach every route; a
  // permission model that locked it out would only be a permission model with a hole in it
  // somewhere else.
  assert.equal(canAdmin("bearer", parseOwners("")), true);
  assert.equal(canAdmin("bearer", OWNERS), true);
  assert.equal(canView("bearer", OWNERS, bookings), true);
  assert.equal(isMember("bearer", { members: [{ email: "bearer" }] }), false,
    "'bearer' is a sentinel, never an address to match on a member list");
});

test("a member sees the mailboxes it is on, and no others", () => {
  assert.equal(canView("member@example.com", OWNERS, support), true);
  assert.equal(canView("member@example.com", OWNERS, bookings), false);
  assert.equal(canView("MEMBER@Example.com", OWNERS, support), true, "case never changes the answer");
  assert.equal(canAdmin("member@example.com", OWNERS), false, "a member may not configure");
});

test("a stranger sees nothing and may administer nothing", () => {
  assert.equal(canView("stranger@example.com", OWNERS, support), false);
  assert.equal(canView("stranger@example.com", OWNERS, bookings), false);
  assert.equal(canAdmin("stranger@example.com", OWNERS), false);
  // A service token verifies as "access" with no email claim. It is nobody.
  assert.equal(canAdmin("access", OWNERS), false);
  assert.equal(canView("access", OWNERS, support), false);
});

test("an empty or missing identity is never anybody", () => {
  for (const id of [null, undefined, "", "   "]) {
    assert.equal(canAdmin(id, OWNERS), false, JSON.stringify(id));
    assert.equal(canView(id, OWNERS, support), false, JSON.stringify(id));
    assert.equal(isMember(id, { members: [{ email: "" }] }), false, JSON.stringify(id));
  }
});

test("an unconfigured mailbox has no members, so only an owner can see it", () => {
  // config() returns null for an address that has only ever received. Mail for an address
  // nobody has claimed is the operator's problem, not a stranger's.
  assert.equal(canView("member@example.com", OWNERS, null), false);
  assert.equal(canView("owner@example.com", OWNERS, null), true);
});

test("mode is irrelevant: a member is a member in either", () => {
  assert.equal(isMember("other@example.com", bookings), true, "mode 'send'");
  assert.equal(isMember("member@example.com", support), true, "mode 'forward'");
});

test("addresses are compared literally — gmail dots and +tags are NOT normalised", () => {
  // Two different strings are two different identities. An equivalence rule that is right for
  // one provider is wrong for the next, and being wrong here hands over a mailbox.
  const box = { members: [{ email: "first.last@gmail.com", mode: "send" }] };
  assert.equal(isMember("firstlast@gmail.com", box), false);
  assert.equal(isMember("first.last+tag@gmail.com", box), false);
  assert.equal(isMember("first.last@gmail.com", box), true);
});

test("visibleMailboxes: everything for an owner, the member's own for anyone else", () => {
  const all = [support, bookings];
  assert.deepEqual(visibleMailboxes(all, "owner@example.com", OWNERS), all);
  assert.deepEqual(visibleMailboxes(all, "bearer", OWNERS), all);
  assert.deepEqual(visibleMailboxes(all, "member@example.com", OWNERS), [support]);
  assert.deepEqual(visibleMailboxes(all, "stranger@example.com", OWNERS), []);
  assert.deepEqual(visibleMailboxes(null, "owner@example.com", OWNERS), []);
});
