// The body parser, on the four shapes that actually arrive. The fourth is the important
// one: it is the shape that silently ate every Google DMARC report for a fortnight, and the
// anchored header regexes in mime.js are the fix. If someone "tidies" those regexes, this
// test is what says so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBody } from "../src/parse-mail.js";
import { stripHtml } from "../src/mime.js";
import { b64Lines } from "../src/build-mime.js";

const crlf = (s) => s.replace(/\n/g, "\r\n");

test("non-multipart text/plain: the body is the whole message body", () => {
  const raw = crlf(`From: Alice <alice@example.com>
To: support@example.com
Subject: Squawk 7700 over the Negev
Content-Type: text/plain; charset=utf-8

Picked it up at 14:02, FL310, heading 180.
`);
  const r = parseBody(raw);
  assert.match(r.text, /Picked it up at 14:02, FL310, heading 180\./);
  assert.equal(r.html, null);
  assert.deepEqual(r.attachments, []);
});

test("multipart/alternative: text and html both kept, container not listed", () => {
  const raw = crlf(`From: Bob <bob@example.com>
To: support@example.com
Subject: Both
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="B1"

--B1
Content-Type: text/plain; charset=utf-8

plain version
--B1
Content-Type: text/html; charset=utf-8

<p>html <b>version</b></p>
--B1--
`);
  const r = parseBody(raw);
  assert.match(r.text, /plain version/);
  assert.match(r.html, /<b>version<\/b>/);
  assert.deepEqual(r.attachments, [], "the multipart container must not be listed as an attachment");
});

test("multipart/mixed: the attachment is LISTED, not decoded into the row", () => {
  const pdf = "%PDF-1.4 not really a pdf, but bytes are bytes\n";
  const raw = crlf(`From: Carol <carol@example.com>
To: support@example.com
Subject: Monthly
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="M1"

--M1
Content-Type: text/plain; charset=utf-8

See attached.
--M1
Content-Type: application/pdf; name="report.pdf"
Content-Disposition: attachment; filename="report.pdf"
Content-Transfer-Encoding: base64

${b64Lines(pdf)}
--M1--
`);
  const r = parseBody(raw);
  assert.match(r.text, /See attached\./);
  assert.equal(r.attachments.length, 1);
  assert.equal(r.attachments[0].filename, "report.pdf");
  assert.equal(r.attachments[0].type, "application/pdf");
  assert.equal(r.attachments[0].size, pdf.length, "size is the decoded byte count");
  assert.equal(Object.hasOwn(r.attachments[0], "bytes"), false, "attachment CONTENT never enters the row");
});

test("folded headers + an ARC h= list containing 'content-type:content-transfer-encoding:'", () => {
  // The ARC-Message-Signature's h= field is a literal list of signed header NAMES. An
  // unanchored header lookup matches inside it and comes back with Content-Type "to:from"
  // and Content-Transfer-Encoding "content-disposition:...", so the base64 body is never
  // decoded and the message silently loses its body. Anchoring to line starts is the fix,
  // and folded continuations begin with whitespace so ^ excludes them for free.
  const body = "Positions: 412 — Aircraft: 87\n";
  const raw = crlf(`Return-Path: <bot@example.net>
ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=example.net; s=arc-20240605;
 h=to:from:subject:date:message-id:mime-version:content-type:content-transfer-encoding:
 list-id:list-unsubscribe; bh=2jmj7l5rSw0yVb/vlWAYkK/YBwk=; b=AAAA
From: Feed Bot <bot@example.net>
To: support@example.com
Subject: Daily rollup
Content-Type: text/plain;
\tcharset="utf-8"
Content-Transfer-Encoding: base64

${b64Lines(body)}
`);
  const r = parseBody(raw);
  assert.equal(r.text.trim(), "Positions: 412 — Aircraft: 87",
    "base64 body decoded, and the utf-8 charset read off the FOLDED Content-Type");
  assert.deepEqual(r.attachments, [], "the message must not be mistaken for an attachment");
});

test("html-only message still yields text, so a reply has something to quote", () => {
  const raw = crlf(`From: Dee <dee@example.com>
To: support@example.com
Subject: html only
Content-Type: text/html; charset=utf-8

<p>Hello &amp; goodbye</p>
`);
  const r = parseBody(raw);
  assert.match(r.html, /Hello/);
  assert.equal(r.text, "Hello & goodbye");
});

test("a malformed message loses its body, never the caller", () => {
  assert.deepEqual(parseBody(""), { text: null, html: null, attachments: [] });
  assert.deepEqual(parseBody(null), { text: null, html: null, attachments: [] });
});

// ---- the derived text ---------------------------------------------------
//
// ONE derivation, two readers: the stored text of an html-only message, and the original
// quoted inside a plain-text reply. What it does to a marketing signature is therefore not a
// cosmetic question — it is what a stranger reads underneath the answer they were sent.

test("a link keeps its target, because a reader of a quote cannot hover", () => {
  assert.equal(stripHtml('<a href="https://example.com/x">the docs</a>'), "the docs (https://example.com/x)");
  assert.equal(stripHtml('<a href=\'https://example.com/x\'>the docs</a>'), "the docs (https://example.com/x)",
    "single-quoted href");
  assert.equal(stripHtml('<a class="btn" href="https://example.com/x" target="_blank">the <b>docs</b></a>'),
    "the docs (https://example.com/x)", "other attributes and nested markup do not confuse it");
});

test("a link that is already its own url is not written out twice", () => {
  assert.equal(stripHtml('<a href="https://example.com/x">https://example.com/x</a>'), "https://example.com/x");
  assert.equal(stripHtml('<a href="https://example.com/x/">https://example.com/x</a>'), "https://example.com/x",
    "a trailing slash is not a difference worth printing");
  assert.equal(stripHtml('<a href="mailto:a@b.co">a@b.co</a>'), "a@b.co");
  assert.equal(stripHtml('<a href="mailto:a@b.co">write to us</a>'), "write to us (a@b.co)");
});

test("a link with nothing a reader could act on keeps only its text", () => {
  assert.equal(stripHtml('<a href="#top">back to top</a>'), "back to top");
  assert.equal(stripHtml('<a href="cid:image001@x">logo</a>'), "logo");
  assert.equal(stripHtml('<a href="javascript:alert(1)">click</a>'), "click");
  assert.equal(stripHtml("<a>no href at all</a>"), "no href at all");
  assert.equal(stripHtml('<a href="https://example.com/x"><img src="cid:i"></a>'), "https://example.com/x",
    "an image-only link is worth its url");
});

test("images contribute nothing at all — no alt, no base64, no placeholder", () => {
  const sig = '<p>Regards</p><img src="cid:image001.png@01D" alt="image001.png" width="120">' +
    '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg">';
  assert.equal(stripHtml(sig), "Regards");
  assert.equal(/image001|base64|\[/.test(stripHtml(sig)), false);
});

test("br and the end of a block become ONE newline, never two", () => {
  // Gmail wraps each individual line in a div and Outlook each in a p. A blank line per block
  // would come back to the sender at twice the length they wrote.
  assert.equal(stripHtml("one<br>two<br />three"), "one\ntwo\nthree");
  assert.equal(stripHtml("<p>one</p><p>two</p>"), "one\ntwo");
  assert.equal(stripHtml('<div class="a">one</div><div>two</div>'), "one\ntwo");
  assert.equal(stripHtml("<ul><li>one</li><li>two</li></ul>"), "one\ntwo");
  assert.equal(stripHtml("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>"), "a b\nc");
  assert.equal(stripHtml("<h2>Title</h2><p>body</p>"), "Title\nbody");
});

test("blank runs collapse and no line keeps a stray indent", () => {
  assert.equal(stripHtml("<p>one</p><br><br><br><p>two</p>"), "one\n\ntwo", "a deliberate gap survives, once");
  assert.equal(stripHtml("<div>   one   </div><div>   two   </div>"), "one\ntwo");
  assert.equal(stripHtml("<script>var x = 1</script><p>visible</p>"), "visible");
  assert.equal(stripHtml("<style>p{color:red}</style><p>visible</p>"), "visible");
});

test("the derivation never throws on nothing", () => {
  assert.equal(stripHtml(null), "");
  assert.equal(stripHtml(undefined), "");
  assert.equal(stripHtml(""), "");
});
