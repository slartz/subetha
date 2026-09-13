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

// A skip is a delivery the loop guard or a member rule declined to make, and it is recorded ok
// although NOTHING WAS SENT. So it proves exactly as little about whether the address is a
// verified destination as no row at all, and the warning stays up: the rule is last.ok AND a
// mode that is not "skip". This is the decision the test names — the reading where a skip
// cleared the warning was the one that let an unverified address look proven.
test("a skip proves nothing, so a member whose only row is a skip is still warned about", () => {
  assert.equal(needsForwardWarning({ mode: "forward", last: { ok: 1, mode: "skip" } }), true);
  assert.equal(needsForwardWarning({ mode: "forward", last: { ok: true, mode: "skip" } }), true);
});

// The other side of the same rule: a delivery that actually left clears it, whatever else is on
// the row. An absent mode is an ordinary forward or send — only "skip" means nothing was sent.
test("a delivery that actually left clears the warning", () => {
  assert.equal(needsForwardWarning({ mode: "forward", last: { ok: 1, mode: "forward" } }), false);
  assert.equal(needsForwardWarning({ mode: "forward", last: { ok: 1 } }), false);
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

// ---- what the page is allowed to load, and where things sit -------------
//
// These four are the page's own structure, asserted because each of them is silent when it
// breaks: an external URL still renders, a second icon link still shows an icon, a missing
// subtitle looks like a design choice, and a danger block that drifted back up the page is
// still a working danger block.

// AGENTS.md's hardest UI rule, and until now the only one nothing checked. The Access login is
// all that stands between this page and every mailbox in the zone; a font CDN, an icon sprite
// or a script tag on it is a second door, and the page is served from a worker that can send
// mail as any address in the zone.
test("the page loads nothing from the network, at all", () => {
  assert.equal(/https?:\/\//.test(page), false, "no absolute URL may appear anywhere in the page");
  assert.equal(/@import/.test(page), false, "no CSS @import");
  assert.equal(/@font-face/.test(page), false, "no font file, however it is reached");
  assert.equal(/<script[^>]+src=/.test(page), false, "every script on this page is inline");
  // The only <link> is the inline data: favicon, and the only <style> is theme.js.
  for (const m of page.matchAll(/<link\b[^>]*>/g))
    assert.match(m[0], /^<link rel="icon" href="data:image\/svg\+xml,/, `unexpected link: ${m[0]}`);
});

test("there is exactly one icon link, and it is the inline one", () => {
  assert.equal((page.match(/rel="icon"/g) || []).length, 1,
    "two icon links are a size negotiation; one SVG scales");
});

// Not "mail relay on the edge", which an earlier board carried and which is wrong — SubEtha
// extends Email Routing rather than replacing it.
test("the wordmark carries its subtitle, once", () => {
  assert.equal((page.match(/Email Routing, extended\./g) || []).length, 1);
  assert.match(page, /<h1>SubEtha<\/h1>\s*<p class="tag">Email Routing, extended\.<\/p>/,
    "the subtitle belongs under the wordmark, not beside it");
  assert.equal(/mail relay on the edge/.test(page), false);
});

// The block that removes a mailbox is the last thing on the page, below the mail rather than
// beside the settings it used to sit in: it is the one destructive control here, and nothing
// an operator reaches for should be next to it.
test("the danger block is the last block on the page, below both message panes", () => {
  assert.ok(page.indexOf('id="dangerzone"') > page.indexOf('<div class="panes">'),
    "the danger block must come after the panes");
  assert.ok(page.indexOf('id="dangerzone"') > page.indexOf('id="msgtitle"'),
    "and after the reader, which is the second of them");
  assert.ok(page.indexOf('id="dangerzone"') > page.indexOf('id="storagerow"'),
    "it left the settings block, and did not come back");
});

// The two policies the reader puts at the top of the iframe document, asserted as literal text
// rather than as a shape. structure.test.mjs checks that they are USED, in both branches; this
// checks WHAT they say, because a policy that is quietly widened still renders a message.
test("the reader's two CSP strings are exactly the two policies, byte for byte", () => {
  const policy = (img) => '<meta http-equiv="Content-Security-Policy" content="default-src ' +
    "'none'; img-src " + img + "; style-src 'unsafe-inline'; font-src data:\">";
  assert.ok(page.includes("var CSP_BLOCKED = " + JSON.stringify(policy("data:")) + ";"),
    "the blocked policy must allow data: images and nothing else");
  assert.ok(page.includes("var CSP_REMOTE = " + JSON.stringify(policy("data: https:")) + ";"),
    "and the one the operator opts into must add https: and nothing else");
});
