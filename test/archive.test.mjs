// R2 keys. A key is not a cosmetic detail: it is how a message is found again years later,
// and a Message-ID is a string a stranger chose, so it goes nowhere near a path unsanitised.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r2Key, keySafe } from "../src/archive.js";

const AT = Date.UTC(2026, 8, 12, 6, 30, 0); // 2026-09-12T06:30:00Z

test("the shape is mailbox / year / month / message-id", () => {
  assert.equal(r2Key("support@example.com", "<abc123@example.com>", AT),
    "support@example.com/2026/09/abc123@example.com.eml");
});

test("the month is zero-padded and taken in UTC", () => {
  assert.equal(r2Key("x@y.co", "<m>", Date.UTC(2026, 0, 1)), "x@y.co/2026/01/m.eml");
  assert.equal(r2Key("x@y.co", "<m>", Date.UTC(2026, 11, 31, 23, 59)), "x@y.co/2026/12/m.eml");
});

test("path traversal and other surprises in a Message-ID cannot escape the prefix", () => {
  // A dot survives — "example.com" and ".eml" both need it — but a SLASH never does, and
  // an R2 key is an opaque string rather than a filesystem path, so a surviving ".." is a
  // literal two dots in a name and not a parent directory.
  assert.equal(r2Key("support@example.com", "<../../../etc/passwd>", AT),
    "support@example.com/2026/09/.._.._.._etc_passwd.eml");
  assert.equal(r2Key("support@example.com", "<a/b\\c?d#e>", AT),
    "support@example.com/2026/09/a_b_c_d_e.eml");
  assert.equal(r2Key("../../evil", "<m>", AT), ".._.._evil/2026/09/m.eml");
});

test("a message with no usable Message-ID still gets a unique key", () => {
  const a = r2Key("support@example.com", "", AT);
  const b = r2Key("support@example.com", null, AT);
  assert.match(a, /^support@example\.com\/2026\/09\/[0-9a-f-]{36}\.eml$/);
  assert.notEqual(a, b, "two anonymous messages must not collide");
});

test("an absurdly long Message-ID is truncated, not rejected", () => {
  const long = `<${"a".repeat(500)}@example.com>`;
  const k = r2Key("support@example.com", long, AT);
  assert.equal(k.length, "support@example.com/2026/09/".length + 120 + 4);
});

test("keySafe keeps what an address needs and nothing else", () => {
  assert.equal(keySafe("first.last+tag@sub.example-1.com"), "first.last+tag@sub.example-1.com");
  assert.equal(keySafe("a b\tc\nd"), "a_b_c_d");
});
