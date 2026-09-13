// The page's own rules.
//
// Two of them are worth asserting: the typed confirmation that arms the mailbox delete, and the
// caution note under a forward member. Both live in ui.js as exported functions and are
// interpolated into the client script as source, so what is asserted here is the text the
// browser runs — the last three tests are what keeps that true.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { confirmsDelete, needsForwardWarning, renderUi } from "../src/ui.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const page = renderUi({ identity: "owner@example.com" });

test("the typed address arms the delete, exactly", () => {
  assert.equal(confirmsDelete("support@example.com", "support@example.com"), true);
});

test("the typed address is compared case-insensitively, both sides", () => {
  assert.equal(confirmsDelete("SUPPORT@Example.COM", "support@example.com"), true);
  assert.equal(confirmsDelete("support@example.com", "Support@Example.com"), true);
});

test("surrounding whitespace is trimmed — a pasted address carries it", () => {
  assert.equal(confirmsDelete("  support@example.com \n", "support@example.com"), true);
  assert.equal(confirmsDelete("support@example.com", "  support@example.com  "), true);
});

test("a different address does not arm the delete", () => {
  assert.equal(confirmsDelete("hello@example.com", "support@example.com"), false);
});

test("a prefix of the address does not arm the delete", () => {
  assert.equal(confirmsDelete("support@example.co", "support@example.com"), false);
  assert.equal(confirmsDelete("support@example.com ok", "support@example.com"), false);
});

test("an empty box never arms the delete", () => {
  assert.equal(confirmsDelete("", "support@example.com"), false);
  assert.equal(confirmsDelete("   ", "support@example.com"), false);
});

// The page can be drawn with no mailbox selected. Comparing "" with "" would arm the button on
// an empty box, which is the one input an operator produces by doing nothing at all.
test("no mailbox selected means nothing to confirm, whatever is typed", () => {
  assert.equal(confirmsDelete("", ""), false);
  assert.equal(confirmsDelete("", null), false);
  assert.equal(confirmsDelete("anything", ""), false);
  assert.equal(confirmsDelete(null, null), false);
  assert.equal(confirmsDelete(undefined, undefined), false);
});

test("a forward member nothing has been sent to yet is warned about", () => {
  assert.equal(needsForwardWarning({ email: "a@b.example", mode: "forward", last: null }), true);
  assert.equal(needsForwardWarning({ email: "a@b.example", mode: "forward" }), true);
});

test("a forward member whose last delivery failed is warned about", () => {
  assert.equal(needsForwardWarning({ mode: "forward", last: { ok: 0, error: "not verified" } }), true);
  assert.equal(needsForwardWarning({ mode: "forward", last: { ok: false } }), true);
});

test("a forward member that has delivered is not warned about", () => {
  assert.equal(needsForwardWarning({ mode: "forward", last: { ok: 1 } }), false);
  assert.equal(needsForwardWarning({ mode: "forward", last: { ok: true } }), false);
});

// A skip is a delivery the loop guard or a member rule declined to make, and it is recorded ok.
// The rule the page follows is last.ok and nothing finer, so a skipped row stops warning — see
// the note in TESTS.md about what this does and does not prove.
test("the rule is last.ok and nothing finer, so a skipped delivery stops the warning", () => {
  assert.equal(needsForwardWarning({ mode: "forward", last: { ok: 1, mode: "skip" } }), false);
});

test("send mode is never warned about — the warning is about forwarding", () => {
  assert.equal(needsForwardWarning({ mode: "send", last: null }), false);
  assert.equal(needsForwardWarning({ mode: "send", last: { ok: 0 } }), false);
});

test("nothing is not a member", () => {
  assert.equal(needsForwardWarning(null), false);
  assert.equal(needsForwardWarning(undefined), false);
  assert.equal(needsForwardWarning({}), false);
});

test("both rules reach the browser as source, not as a second hand-written copy", () => {
  assert.match(page, /function confirmsDelete\(typed, address\)/,
    "the client script must carry the asserted function itself");
  assert.match(page, /function needsForwardWarning\(member\)/);
  assert.equal(/function confirmsDelete/.test(readFileSync(join(SRC, "ui.js"), "utf8").split("export function renderUi")[1] || ""), false,
    "there must be exactly one copy of the rule, and it is the exported one above renderUi");
});

test("the mailbox delete is armed by the typed address, never by a confirm()", () => {
  const wiring = page.slice(page.indexOf('el("del").onclick'), page.indexOf('el("del").onclick') + 700);
  assert.match(wiring, /if \(!confirmsDelete\(el\("delconf"\)\.value, cur\)\) return;/,
    "the click must ask the rule again rather than trust the disabled attribute");
  assert.match(wiring, /method: "DELETE"/, "and then make the same call it always made");
  assert.equal(/confirm\(/.test(wiring.replace(/confirmsDelete/g, "")), false,
    "no window.confirm anywhere in the delete path");
});

test("the delete button is inside the owner-only block, and the block is what applyRole hides", () => {
  assert.match(page, /<div class="danger" id="dangerzone">[\s\S]*id="del"[\s\S]*<\/div>/,
    "the delete button must be inside the danger block");
  assert.match(page, /var ids = \["newbox", "save", "addmember", "storagerow", "dangerzone"\];/,
    "and the block must be in the list applyRole hides from a member");
});
