// Mute rules. A rule decides whether mail is delivered at all, so the failure that matters is
// not "a rule did not match" — it is a rule that matches MORE than the person who typed it
// expected, and silently stops mail for everybody on the list. Hence: no regular expressions,
// two comparisons only, and an exact domain match with the subdomain case asserted so the
// narrowness reads as a decision rather than an oversight.
//
// The SQL predicate is the same rule expressed twice, which is the other thing worth testing:
// it runs once, over stored rows, when a rule is created.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIELDS, PATTERN_MAX, normalisePattern, normaliseRule, ruleError,
  matchRule, firstMatch, likeEscape, sqlPredicate,
} from "../src/rules.js";

const msg = (o) => ({ from_addr: null, subject: null, list_id: null, ...o });
const rule = (field, pattern) => ({ id: 1, field, pattern, action: "mute" });

test("the four fields are the four fields", () => {
  assert.deepEqual([...FIELDS].sort(), ["from", "from_domain", "list_id", "subject"]);
});

test("from is the whole address and nothing less", () => {
  const r = rule("from", "alice@example.com");
  assert.equal(matchRule(r, msg({ from_addr: "alice@example.com" })), true);
  assert.equal(matchRule(r, msg({ from_addr: "ALICE@Example.COM" })), true, "case never decides");
  assert.equal(matchRule(r, msg({ from_addr: "alice@example.com.evil.test" })), false);
  assert.equal(matchRule(r, msg({ from_addr: "notalice@example.com" })), false);
  assert.equal(matchRule(r, msg({ from_addr: null })), false);
});

test("from_domain is EXACT: a subdomain is a different domain", () => {
  const r = rule("from_domain", "example.com");
  assert.equal(matchRule(r, msg({ from_addr: "alice@example.com" })), true);
  assert.equal(matchRule(r, msg({ from_addr: "BOB@EXAMPLE.COM" })), true);
  // Both of these are the reason the loose version was not written: one is mail an owner
  // would expect to keep arriving, the other is a stranger's domain that merely ends the same.
  assert.equal(matchRule(r, msg({ from_addr: "alice@mail.example.com" })), false, "subdomains do NOT match in v1");
  assert.equal(matchRule(r, msg({ from_addr: "alice@notexample.com" })), false);
  assert.equal(matchRule(r, msg({ from_addr: "malformed-no-at-sign" })), false);
});

test("subject and list_id are contains, anywhere, either case", () => {
  assert.equal(matchRule(rule("subject", "black friday"), msg({ subject: "RE: Our BLACK FRIDAY sale" })), true);
  assert.equal(matchRule(rule("subject", "black friday"), msg({ subject: "black fridays" })), true);
  assert.equal(matchRule(rule("subject", "black friday"), msg({ subject: "friday, black tie" })), false);
  assert.equal(matchRule(rule("subject", "x"), msg({ subject: null })), false);
  assert.equal(matchRule(rule("list_id", "announce.example.com"),
    msg({ list_id: "Announcements <announce.example.com>" })), true);
  assert.equal(matchRule(rule("list_id", "announce"), msg({ list_id: null })), false);
});

test("a rule with no pattern, or an unknown field, matches nothing", () => {
  // The failure mode to design against: a rule that matches everything and mutes a mailbox.
  for (const r of [rule("subject", ""), rule("subject", null), rule("nonsense", "x"), {}, null])
    assert.equal(matchRule(r, msg({ from_addr: "a@b.co", subject: "anything at all", list_id: "l" })), false,
      JSON.stringify(r));
});

test("firstMatch returns the oldest matching rule, or null", () => {
  const rules = [
    { id: 3, field: "subject", pattern: "sale" },
    { id: 7, field: "from_domain", pattern: "example.com" },
  ];
  assert.equal(firstMatch(rules, msg({ subject: "Big sale", from_addr: "a@example.com" })).id, 3,
    "one match, one attribution — hits have to add up");
  assert.equal(firstMatch(rules, msg({ from_addr: "a@example.com" })).id, 7);
  assert.equal(firstMatch(rules, msg({ subject: "hello" })), null);
  assert.equal(firstMatch([], msg({ subject: "hello" })), null);
  assert.equal(firstMatch(null, msg({})), null);
});

test("what the owner typed is reduced to the bare thing it means", () => {
  assert.deepEqual(normaliseRule("from", '"Alice" <ALICE@Example.com>'), { field: "from", pattern: "alice@example.com" });
  assert.deepEqual(normaliseRule("from_domain", "@Example.COM"), { field: "from_domain", pattern: "example.com" });
  assert.deepEqual(normaliseRule("SUBJECT", "  Black Friday  "), { field: "subject", pattern: "black friday" });
  assert.equal(normalisePattern("a\r\nb"), "a  b", "control characters cannot survive into a pattern");
  assert.equal(normalisePattern("x".repeat(PATTERN_MAX + 50)).length, PATTERN_MAX);
});

test("a rule that could never match is refused at the door", () => {
  assert.match(ruleError({ field: "nope", pattern: "x" }), /unknown rule field/);
  assert.match(ruleError({ field: "subject", pattern: "" }), /needs a pattern/);
  assert.match(ruleError(normaliseRule("from", "alice")), /not an address/);
  assert.match(ruleError(normaliseRule("from_domain", "example")), /not a domain/);
  assert.equal(ruleError(normaliseRule("from", "alice@example.com")), null);
  assert.equal(ruleError(normaliseRule("from_domain", "@example.com")), null);
  assert.equal(ruleError(normaliseRule("subject", "black friday")), null);
  assert.equal(ruleError(normaliseRule("list_id", "announce.example.com")), null);
});

// ---- the same rule, as SQL ------------------------------------------------

test("the predicate binds its value and never interpolates it", () => {
  for (const field of [...FIELDS]) {
    const p = sqlPredicate({ field, pattern: "x@example.com" });
    assert.equal(p.sql.split("?").length - 1, 1, field + ": exactly one placeholder");
    assert.equal(p.sql.includes("x@example.com"), false, field + ": the value is not in the sql");
  }
  assert.equal(sqlPredicate({ field: "nope", pattern: "x" }), null);
  assert.equal(sqlPredicate({ field: "subject", pattern: "" }), null);
  assert.equal(sqlPredicate({}), null);
});

test("LIKE wildcards in a pattern match themselves and nothing else", () => {
  assert.equal(likeEscape("50% off"), "50\\% off");
  assert.equal(likeEscape("a_b"), "a\\_b");
  assert.equal(likeEscape("back\\slash"), "back\\\\slash");
  const p = sqlPredicate({ field: "subject", pattern: "50% off_now" });
  assert.equal(p.arg, "%50\\% off\\_now%");
  assert.match(p.sql, /LIKE \? ESCAPE '\\'/, "the escape character has to be declared or the escapes are literal");
});

test("the equality predicates are equality, and the domain one cannot be fooled by a missing @", () => {
  assert.deepEqual(sqlPredicate({ field: "from", pattern: "Alice@Example.com" }),
    { sql: "lower(from_addr) = ?", arg: "alice@example.com" });
  const d = sqlPredicate({ field: "from_domain", pattern: "example.com" });
  assert.equal(d.arg, "example.com");
  assert.match(d.sql, /instr\(from_addr, '@'\) > 0/,
    "without the guard, a from_addr of 'example.com' with no @ would match the domain rule");
});
