// The body parser, on the four shapes that actually arrive. The fourth is the important
// one: it is the shape that silently ate every Google DMARC report for a fortnight, and the
// anchored header regexes in mime.js are the fix. If someone "tidies" those regexes, this
// test is what says so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBody } from "../src/parse-mail.js";
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
