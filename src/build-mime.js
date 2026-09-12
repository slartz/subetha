// The MIME builder. Pure — no Worker globals, no bindings — so it runs under node for
// tests, and so that the one place that composes an outgoing message is also the one place
// that can be exhaustively tested.
//
// Two properties matter more than anything else here:
//
//   1. NO CALLER CAN INJECT A HEADER. Every value that reaches a header line has its CR
//      and LF removed first, so a subject of "x\r\nBcc: evil@example.com" becomes one
//      header whose value happens to contain the text "Bcc:", and not a Bcc line. The UI
//      takes free text from a browser and the reply route takes the Subject of a message a
//      stranger sent; both arrive here.
//   2. NO INVALID ADDRESS IS EVER HANDED TO THE BINDING. Every address is validated and an
//      invalid one throws rather than being silently dropped — a send that half-happened is
//      worse than one that did not.

// RFC-ish, deliberately stricter than the RFC: no quoted local parts, no bare TLDs, no
// address literals. Everything this worker sends to is either a member the owner typed or
// a header off a real message, and the cost of refusing an exotic-but-legal address is a
// visible error, while the cost of accepting a malformed one is a send that cannot be
// explained afterwards.
export const ADDR_RE =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

// NO trim(). An address that arrives with whitespace — a CRLF above all — is not a valid
// address, it is a caller that has not normalised its input, and answering "yes, valid" to
// the untrimmed string invites that caller to use the untrimmed string. Every caller here
// trims (and lowercases) before asking.
export const validAddr = (a) => typeof a === "string" && a.length <= 254 && ADDR_RE.test(a);
export const domainOf = (a) => String(a || "").split("@")[1]?.toLowerCase() || "";

// The bare address out of "Name <a@b.c>", or "" when there is none to be had.
export function addrOf(v) {
  const s = String(v ?? "").trim();
  const angled = /<([^>]*)>/.exec(s)?.[1];
  const bare = (angled ?? s).trim();
  return validAddr(bare) ? bare.toLowerCase() : "";
}

// Every header value passes through here. Control characters go too: a NUL or a lone CR in
// a header is a parser disagreement waiting to happen, and nothing legitimate carries one.
export const headerValue = (v) =>
  String(v ?? "").replace(/[\r\n]+/g, " ").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();

const ASCII = /^[\x20-\x7e]*$/;

function b64Bytes(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(bin);
}
export const b64 = (s) => b64Bytes(s instanceof Uint8Array ? s : new TextEncoder().encode(String(s)));
export const b64Lines = (s) => (b64(s).match(/.{1,76}/g) || []).join("\r\n");

// RFC 2047. One encoded word may not exceed 75 characters including the =?utf-8?B?...?=
// furniture, so a long Hebrew subject becomes several words — split on CHARACTER
// boundaries, never inside a multi-byte sequence, because half a UTF-8 character decoded on
// the far side is a replacement glyph in the middle of a word.
export function encodeWords(s) {
  const v = headerValue(s);
  if (!v || ASCII.test(v)) return v;
  const enc = new TextEncoder();
  const MAX_BYTES = 45;                 // 45 bytes -> 60 base64 chars; +12 furniture = 72
  const words = [];
  let buf = [];
  let n = 0;
  for (const ch of v) {
    const bytes = enc.encode(ch);
    if (n + bytes.length > MAX_BYTES && buf.length) { words.push(buf.join("")); buf = []; n = 0; }
    buf.push(ch);
    n += bytes.length;
  }
  if (buf.length) words.push(buf.join(""));
  return words.map((w) => `=?utf-8?B?${b64(w)}?=`).join(" ");
}

// "Alice <a@b.c>". A non-ASCII name becomes an encoded word and is NOT quoted — an
// encoded-word inside a quoted-string is not decoded, it is shown literally.
export function addressWithName(addr, name) {
  const a = String(addr).trim();
  if (!validAddr(a)) throw new Error(`invalid address: ${JSON.stringify(String(addr).slice(0, 120))}`);
  const n = headerValue(name);
  if (!n) return a;
  if (ASCII.test(n)) return `"${n.replace(/[\\"]/g, (c) => `\\${c}`)}" <${a}>`;
  return `${encodeWords(n)} <${a}>`;
}

// RFC 5322 folding: break at spaces so no line exceeds 76 characters, continuations
// prefixed with one space. A single token longer than the limit is left alone — there is no
// legal place to break inside it, and a References: header of long Message-IDs is exactly
// that case.
export function fold(line) {
  const LIMIT = 76;
  if (line.length <= LIMIT) return line;
  const out = [];
  let cur = "";
  for (const tok of line.split(" ")) {
    if (!cur) { cur = tok; continue; }
    if (cur.length + 1 + tok.length > LIMIT) { out.push(cur); cur = tok; } else cur += ` ${tok}`;
  }
  if (cur) out.push(cur);
  return out.join("\r\n ");
}

export const rfcDate = (d = new Date()) => new Date(d).toUTCString().replace("GMT", "+0000");
export const newMessageId = (domain) => `<${crypto.randomUUID()}@${headerValue(domain) || "localhost"}>`;

// Angle-bracketed ids only, and only the ones that look like ids: In-Reply-To/References
// come off a stranger's message, and a value that is not a msg-id is noise at best.
export const msgIds = (v) => (String(v ?? "").match(/<[^<>\s]{1,400}>/g) || []);

const listAddrs = (v) =>
  (Array.isArray(v) ? v : String(v ?? "").split(","))
    .map((x) => String(x).trim()).filter(Boolean);

/**
 * Build a complete RFC 5322 message. Returns a string with CRLF line endings; the caller
 * wraps it in an EmailMessage. Throws on any invalid address.
 *
 * Bodies are ALWAYS base64 with charset=utf-8. It costs 33% and buys immunity from every
 * line-length, bare-CR, trailing-whitespace and 8-bit-transparency argument there is, on a
 * path where the body is whatever a browser textarea or a stranger's message contained.
 */
export function buildMime(opts) {
  const from = String(opts.from || "").trim().toLowerCase();
  if (!validAddr(from)) throw new Error(`invalid From address: ${JSON.stringify(String(opts.from).slice(0, 120))}`);
  const to = listAddrs(opts.to);
  if (!to.length) throw new Error("no To address");
  const cc = listAddrs(opts.cc);
  for (const a of [...to, ...cc]) if (!validAddr(a)) throw new Error(`invalid address: ${JSON.stringify(a.slice(0, 120))}`);
  const replyTo = opts.replyTo ? addrOf(opts.replyTo) : "";
  if (opts.replyTo && !replyTo) throw new Error(`invalid Reply-To address: ${JSON.stringify(String(opts.replyTo).slice(0, 120))}`);

  const h = [];
  h.push(["From", addressWithName(from, opts.fromName)]);
  h.push(["To", to.map((a) => a).join(", ")]);
  if (cc.length) h.push(["Cc", cc.join(", ")]);
  if (replyTo) h.push(["Reply-To", replyTo]);
  h.push(["Subject", encodeWords(opts.subject ?? "")]);
  h.push(["Date", headerValue(opts.date || rfcDate())]);
  h.push(["Message-ID", headerValue(opts.messageId || newMessageId(domainOf(from)))]);
  const irt = msgIds(opts.inReplyTo);
  if (irt.length) h.push(["In-Reply-To", irt[irt.length - 1]]);
  const refs = msgIds(opts.references);
  if (refs.length) h.push(["References", refs.join(" ")]);
  for (const [k, v] of Object.entries(opts.headers || {})) {
    const name = headerValue(k).replace(/[^A-Za-z0-9-]/g, "");
    const val = headerValue(v);
    if (name && val) h.push([name, val]);
  }
  h.push(["MIME-Version", "1.0"]);

  const text = String(opts.text ?? "").replace(/\r\n|\r|\n/g, "\r\n");
  const html = opts.html == null ? null : String(opts.html).replace(/\r\n|\r|\n/g, "\r\n");

  let body;
  if (html != null && html !== "") {
    const boundary = `=_subetha_${crypto.randomUUID().replace(/-/g, "")}`;
    h.push(["Content-Type", `multipart/alternative; boundary="${boundary}"`]);
    body =
      `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
      `${b64Lines(text)}\r\n` +
      `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
      `${b64Lines(html)}\r\n` +
      `--${boundary}--\r\n`;
  } else {
    h.push(["Content-Type", "text/plain; charset=utf-8"]);
    h.push(["Content-Transfer-Encoding", "base64"]);
    body = `${b64Lines(text)}\r\n`;
  }

  const head = h.map(([k, v]) => fold(`${k}: ${v}`)).join("\r\n");
  return `${head}\r\n\r\n${body}`;
}

// "Re: x" once, never "Re: Re: x". Localised prefixes (Sv:, Antw:) are not stripped —
// guessing at them mangles a subject that genuinely starts with a word and a colon.
export const reSubject = (s) => {
  const v = headerValue(s);
  return /^re\s*:/i.test(v) ? v : `Re: ${v}`.trim();
};

// "On <date>, <who> wrote:", as every mail client has written it since 1995. Its own function
// because the text alternative of a reply and the html one must say the same sentence, and
// two copies of a sentence are two sentences waiting to disagree.
export function attribution({ date, from } = {}) {
  const who = headerValue(from) || "someone";
  const when = headerValue(date);
  return when ? `On ${when}, ${who} wrote:` : `${who} wrote:`;
}

// The attribution line and the quoted original. Quoting an already-quoted line just deepens
// it, which is correct.
export function quote(text, opts = {}) {
  const lines = String(text ?? "").replace(/\r\n|\r/g, "\n").split("\n");
  return `${attribution(opts)}\n${lines.map((l) => `> ${l}`).join("\n")}`;
}
