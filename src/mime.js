// Adapted from an earlier worker by the same author; see LICENSE. Copied rather than
// imported: SubEtha has no build step and no shared package. A bug fixed here wants the same
// fix in the original.
//
// ONE deliberate change from that original, marked CHANGED at the function: stripHtml()
// renders a link as "text (url)" and drops images entirely. SubEtha quotes its output back to
// a stranger inside a reply, which the original never did.
//
// The anchored header regexes and the boundary-aware splitting are the load-bearing
// properties — see the comment on hdr() for the fortnight of DMARC reports that was lost
// to an unanchored one. Do not "simplify" them.
// MIME helpers. Pure — no Worker globals — so they run under node for tests.
//
// Header regexes are ANCHORED to line starts. Unanchored ones match inside *other*
// headers' values — an ARC-Message-Signature's h= field literally contains the text
// "content-type:content-transfer-encoding:", which is how an earlier parser with an
// unanchored lookup silently dropped every Google DMARC report for a fortnight. Folded
// continuations begin with whitespace, so ^ excludes them for free.
export const hdr = (head, name) =>
  new RegExp(`^${name}:[ \\t]*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, "im").exec(head)?.[1]
    ?.replace(/\r?\n[ \t]+/g, " ").trim() ?? "";

// Where a header block comes from, for every caller of hdr(): the message up to its first
// blank line. Not a fixed number of bytes — a byte count is a guess about how big a header
// block gets, and Gmail's forwarder settles the argument by putting 8-12 KB of Received:,
// ARC-* and DKIM-Signature lines in front of the From: that matters. The cap is only for a
// malformed message with no blank line in it at all, so that hdr's regexes are never run
// over a megabyte of base64.
export const HEAD_MAX = 65536;
export const headOf = (raw) => {
  const cut = String(raw ?? "").search(/\r?\n\r?\n/);
  return cut < 0 ? String(raw ?? "").slice(0, HEAD_MAX) : String(raw).slice(0, cut);
};

export function b64ToBytes(b64) {
  const bin = atob(b64.replace(/[^A-Za-z0-9+/=]/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function qpDecode(s) {
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// The raw message is handled as a byte-transparent string (one char per byte) so that
// bodies in any charset survive parsing intact and are decoded once, by their own
// charset. TextDecoder("latin1") is NOT that — WHATWG maps it to windows-1252.
export function bytesToLatin1(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return s;
}
export function latin1ToBytes(s) {
  // A string that was never byte-transparent (a test fixture with real Hebrew in it)
  // is encoded as UTF-8 rather than corrupted.
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xff) return new TextEncoder().encode(s);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ISO-8859-8 / windows-1255 by hand, for a runtime whose TextDecoder lacks them. The
// Hebrew block is contiguous (0xE0–0xFA → U+05D0–U+05EA); windows-1255 adds nikud and ₪.
export function hebrew8bit(bytes) {
  let s = "";
  for (const b of bytes) {
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b >= 0xe0 && b <= 0xfa) s += String.fromCharCode(0x05d0 + b - 0xe0);
    else if (b >= 0xc0 && b <= 0xd8) s += String.fromCharCode(0x05b0 + b - 0xc0);
    else if (b === 0xa4) s += "\u20aa";
    else if (b === 0xa0) s += " ";
    else if (b === 0xfd || b === 0xfe) s += "";
    else if (b >= 0xa1 && b <= 0xbf) s += String.fromCharCode(b);
    else s += "\ufffd";
  }
  return s;
}

const HEBREW_CS = /^(iso-?8859-?8(-i)?|windows-?1255|cp1255|hebrew)$/;
export function decodeText(bytes, charset) {
  const cs = String(charset || "utf-8").toLowerCase().trim().replace(/^iso-?8859-?8-i$/, "iso-8859-8");
  try { return new TextDecoder(cs).decode(bytes); } catch {}
  if (HEBREW_CS.test(cs)) return hebrew8bit(bytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// RFC 2047 encoded words in headers: =?charset?B|Q?data?=. Adjacent words are joined
// without the whitespace between them. Israeli vendors send Hebrew subjects this way.
export function decodeWords(s) {
  if (!s || !s.includes("=?")) return s;
  return s.replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=(\s+(?==\?))?/g, (_, cs, enc, data) => {
    try {
      const bytes = /b/i.test(enc)
        ? b64ToBytes(data)
        : latin1ToBytes(data.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))));
      return decodeText(bytes, cs);
    } catch { return _; }
  });
}

// Split a raw message into parts. Non-multipart mail yields a single part whose head is
// the message header block — Google's DMARC reports arrive that way, and so do plenty of
// vendor invoices that attach the PDF as the whole body.
export function parseParts(raw) {
  const headEnd = raw.search(/\r?\n\r?\n/);
  const msgHead = headEnd < 0 ? raw : raw.slice(0, headEnd);
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(msgHead)?.[1];
  const chunks = boundary
    ? raw.split(new RegExp(`\\r?\\n--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
    : [raw];
  const parts = [];
  for (const c of chunks) {
    const he = c.search(/\r?\n\r?\n/);
    if (he < 0) continue;
    const head = c.slice(0, he);
    const ct = hdr(head, "content-type");
    // A nested multipart part carries its own boundary — recurse rather than treat the
    // whole nested block as one body.
    const nested = /^multipart\//i.test(ct) && /boundary="?([^";\r\n]+)"?/i.exec(ct)?.[1];
    if (nested && c !== raw) { parts.push(...parseParts(c)); continue; }
    parts.push({
      head,
      mime: (ct.split(";")[0] || "").trim().toLowerCase(),
      charset: /charset="?([^";\s]+)"?/i.exec(ct)?.[1] || "",
      name: decodeWords(/name="?([^";\r\n]+)"?/i.exec(head)?.[1] || ""),
      cte: hdr(head, "content-transfer-encoding").toLowerCase(),
      body: c.slice(he).replace(/^\r?\n\r?\n/, ""),
    });
  }
  return parts;
}

// Bytes out, always. Decoding to text is the caller's job, with the part's charset.
export const decodeBody = (p) =>
  p.cte === "base64" ? b64ToBytes(p.body) : latin1ToBytes(p.cte === "quoted-printable" ? qpDecode(p.body) : p.body);

// CHANGED from the original: what a link and an image become. There is ONE text derivation in
// SubEtha and it has two readers — the stored text of an html-only message, and the quoted
// original inside a plain-text reply — so what it does to a marketing signature is not a
// cosmetic question. A link keeps its target ("text (url)"), because a reader of the quote
// cannot hover. An image contributes NOTHING: an alt attribute in a signature is
// "image001.png" and a data: src is a screenful of base64, and both are noise in a reply.
const linkText = (attrs, inner) => {
  const raw = /\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(attrs)?.[1] || "";
  const href = (/^["']/.test(raw) ? raw.slice(1, -1) : raw).trim();
  const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  // An anchor, a cid: or a script URL has nothing a reader could act on.
  if (!href || /^(?:#|cid:|data:|javascript:|vbscript:)/i.test(href)) return text;
  const bare = href.replace(/^mailto:/i, "");
  if (!text) return bare;
  const same = (a, b) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
  return same(text, href) || same(text, bare) ? text : `${text} (${bare})`;
};

export const stripHtml = (h) =>
  String(h ?? "")
   .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
   .replace(/<img\b[^>]*>/gi, "")
   .replace(/<a\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/a\s*>/gi, (_, attrs, inner) => linkText(attrs, inner))
   .replace(/<br\s*\/?>/gi, "\n")
   // Closing tags only, as the original had it. Mapping the OPENING tag as well puts a blank
   // line between every pair of blocks, and Gmail wraps each individual LINE in a div — the
   // quote would come back to the sender at twice its length.
   .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|ul|ol)\s*>/gi, "\n")
   .replace(/<[^>]+>/g, " ")
   .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
   .replace(/[ \t]+/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

export const ATTACH = /^(application\/(pdf|zip|octet-stream|vnd\.|msword)|image\/)/i;
