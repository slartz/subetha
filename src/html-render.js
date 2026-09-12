// Turning a stored HTML body into something safe to put in front of an operator, and into
// something small enough to quote back in a reply. Pure — no bindings, no Worker globals
// beyond the ones build-mime.js already needs — so every branch below is node-testable.
//
// Three jobs, one pass:
//
//   1. INLINE cid: IMAGES. An Outlook or Apple signature references its logo as
//      <img src="cid:image001.png@01D..."> — a part of the same message, not a URL. The
//      reader's iframe has an EMPTY sandbox and therefore an opaque origin, so a fetch route
//      for parts would not carry the Access cookie and would 401. There is no route to add:
//      the bytes are read out of the archived .eml and folded into the markup as data: URIs.
//   2. NEUTRALISE REMOTE IMAGES. A remote <img> in mail is a read receipt with a URL, and it
//      is the sender who chose it. Every http(s) src becomes data-remote-src plus a
//      transparent placeholder, counted, and loaded only when the operator asks.
//   3. SANITISE. Scripts, event handlers, frames, plugins, <base>, <meta http-equiv> and
//      javascript:/vbscript: URLs are removed. This is DEFENCE IN DEPTH, not the defence: the
//      iframe's empty sandbox and the CSP the reader prepends are. It is here because the
//      same function also builds the quoted original inside an outgoing reply, where there is
//      no sandbox at all — the recipient's mail client is.
//
// It is not a parser. It is a tag rewriter, deliberately, because a parser is a dependency
// and because the two layers underneath it do not care what this one misses.
import { parseParts, decodeBody, hdr, decodeWords, bytesToLatin1 } from "./mime.js";
import { b64, attribution } from "./build-mime.js";

// A 1x1 transparent GIF. Inline rather than a route: the iframe can load nothing but data:.
export const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// Per image and for all of them together. A data: URI costs 33% over the bytes and the whole
// document is handed to the browser in one JSON response, so a signature with a 5 MB hero
// image must not decide how big that response is. Over either cap the src is left as the
// cid: it was: unresolved and visibly broken beats a response nobody can load.
export const MAX_INLINE_BYTES = 2 * 1024 * 1024;
export const MAX_INLINE_TOTAL = 6 * 1024 * 1024;

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Attribute values keep their entities: re-escaping & would turn a legitimate &amp; in a URL
// into &amp;amp;. Only what could end the attribute or start a tag is escaped.
const escAttr = (s) => String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// "the rest of a tag": quoted attribute values may contain > and must not end it.
const INSIDE = `(?:"[^"]*"|'[^']*'|[^>"'])*`;
const TAG = new RegExp(`<([a-zA-Z][a-zA-Z0-9:._-]*)(${INSIDE})>`, "g");
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;

// Elements removed with their content. <style> is NOT among them in the READER: its CSP allows
// inline style, mail is laid out with it, and CSS cannot navigate or execute inside the iframe.
// It IS removed from a reply quote — see the styleBlocks option on renderHtml.
const KILLED = "script|iframe|object|embed";

// Attributes that can carry a URL, and are therefore worth asking what scheme it is.
const URL_ATTRS = new Set(["href", "src", "srcset", "action", "formaction", "background", "poster",
  "data", "cite", "longdesc", "usemap", "dynsrc", "lowsrc", "ping", "xlink:href"]);

// Numeric entities and stray control characters are how "javascript:" is written when the
// author does not want it read as javascript:. Normalise before asking.
const schemeish = (v) => String(v ?? "")
  .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#(\d+);?/g, (_, d) => String.fromCharCode(+d))
  .replace(/[\x00-\x20]/g, "")
  .toLowerCase();

const dangerousUrl = (v) => /^(?:javascript|vbscript):/.test(schemeish(v));
const isCid = (v) => /^\s*cid:/i.test(String(v ?? ""));
const isRemote = (v) => /^\s*(?:https?:)?\/\//i.test(String(v ?? ""));

function stripElements(s, killStyle) {
  let out = String(s);
  const killed = killStyle ? `${KILLED}|style` : KILLED;
  const paired = new RegExp(`<\\s*(${killed})\\b${INSIDE}>[\\s\\S]*?<\\s*/\\s*\\1\\s*>`, "gi");
  // Nested ones need a second look; bounded so a pathological document cannot spin here.
  for (let i = 0; i < 4; i++) {
    const next = out.replace(paired, "");
    if (next === out) break;
    out = next;
  }
  // An UNTERMINATED <script> hides the rest of the document from the eye but not from the
  // parser, so the rest of the document goes with it. A visible "<script" in prose would
  // have opened a script element in the browser too.
  out = out.replace(/<\s*script\b[\s\S]*$/i, "");
  out = out.replace(new RegExp(`<\\s*/?\\s*(?:${killed})\\b${INSIDE}>`, "gi"), "");
  // A form is unwrapped rather than emptied: its content is usually the visible text of a
  // marketing message, and with no form around them the controls inside submit nowhere.
  out = out.replace(new RegExp(`<\\s*/?\\s*form\\b${INSIDE}>`, "gi"), "");
  out = out.replace(new RegExp(`<\\s*base\\b${INSIDE}>`, "gi"), "");
  // Only http-equiv: <meta charset> is worth keeping and cannot redirect anything.
  out = out.replace(new RegExp(`<\\s*meta\\b${INSIDE}>`, "gi"), (m) => /\bhttp-equiv\b/i.test(m) ? "" : m);
  return out;
}

function parseAttrs(s) {
  // A trailing slash belongs to the tag, not to the last attribute — but only when it stands
  // alone, or "href=http://x/" would lose the slash that is part of the URL.
  const src = String(s).replace(/(^|[\s"'])\/\s*$/, "$1");
  const out = [];
  for (const m of src.matchAll(ATTR)) {
    if (m[2] == null) { out.push([m[1], null]); continue; }
    const v = /^["']/.test(m[2]) ? m[2].slice(1, -1) : m[2];
    out.push([m[1], v]);
  }
  return out;
}

const renderTag = (name, attrs) =>
  `<${name}${attrs.map(([k, v]) => (v === null ? ` ${k}` : ` ${k}="${escAttr(v)}"`)).join("")}>`;

// Closing tags, comments and doctypes do not match TAG (it requires a letter after the <),
// so they pass through untouched.
const walkTags = (s, handler) =>
  String(s).replace(TAG, (whole, name, attrs) => {
    const out = handler(name.toLowerCase(), parseAttrs(attrs), whole);
    return out === null ? "" : renderTag(name, out);
  });

function attrPass(name, attrs, ctx) {
  const out = [];
  for (const [k, v] of attrs) {
    const key = k.toLowerCase();
    // Every inline handler, by name rather than by list: onclick, onerror, onanimationend,
    // and the one added to the platform next year.
    if (/^on/.test(key)) continue;
    if (key === "srcdoc") continue;
    if (v !== null && key === "style") { out.push([k, v.replace(/(?:javascript|vbscript)\s*:/gi, "")]); continue; }
    if (v !== null && URL_ATTRS.has(key) && dangerousUrl(v)) continue;
    out.push([k, v]);
  }
  if (name !== "img") return out;
  const i = out.findIndex(([k]) => k.toLowerCase() === "src");
  if (i < 0 || out[i][1] === null) return out;
  const src = out[i][1];
  if (isCid(src)) {
    // Removed, not left dangling: a reply must be self-contained, and a cid: that points at
    // the message being quoted resolves to nothing in the recipient's client.
    if (ctx.cidMode === "remove") return null;
    if (ctx.cidMode === "inline") {
      const uri = dataUri(findPart(ctx.parts, src.replace(/^\s*cid:/i, "")), ctx.state);
      if (uri) out[i] = [out[i][0], uri];
    }
    return out;
  }
  if (ctx.remoteMode === "block" && isRemote(src)) {
    ctx.state.remote++;
    // srcset would override the placeholder and cannot survive the round trip through one
    // data-remote-src attribute, so it goes. Retina art in mail is rare; a tracking pixel
    // that loads itself anyway is not.
    const withoutSrcset = out.filter(([k]) => k.toLowerCase() !== "srcset");
    const j = withoutSrcset.findIndex(([k]) => k.toLowerCase() === "src");
    withoutSrcset.splice(j, 1, ["data-remote-src", src], ["src", PIXEL]);
    return withoutSrcset;
  }
  return out;
}

/**
 * The inline-able parts of a raw .eml: anything with a Content-ID, a Content-Location or a
 * filename. Bytes are NOT decoded here — a 4 MB PDF in the same message is not worth decoding
 * to discover that nothing references it.
 */
export function inlineParts(raw) {
  const s = raw instanceof Uint8Array ? bytesToLatin1(raw) : String(raw ?? "");
  let parts;
  try { parts = parseParts(s); } catch { return []; }
  const out = [];
  for (const p of parts) {
    if (/^multipart\//i.test(p.mime)) continue;
    const head = p.head || "";
    const cid = hdr(head, "content-id").replace(/^<|>$/g, "").trim().toLowerCase();
    const location = hdr(head, "content-location").trim().toLowerCase();
    const filename = String(decodeWords(/filename="?([^";\r\n]+)"?/i.exec(head)?.[1] || "") || p.name || "")
      .trim().toLowerCase();
    if (!cid && !location && !filename) continue;
    out.push({ cid, location, filename, type: p.mime || "application/octet-stream", part: p });
  }
  return out;
}

// Content-ID first — it is what the reference means. Content-Location and the filename are a
// fallback for the senders who write src="cid:logo.png" and set no Content-ID at all.
function findPart(parts, ref) {
  const base = String(ref ?? "").trim().replace(/^<|>$/g, "").toLowerCase();
  if (!base || !parts.length) return null;
  const tries = [base, base.replace(/&amp;/g, "&")];
  try { tries.push(decodeURIComponent(base)); } catch { /* a stray % is not an escape */ }
  for (const t of tries) { const p = parts.find((x) => x.cid && x.cid === t); if (p) return p; }
  for (const t of tries) { const p = parts.find((x) => x.location && x.location === t); if (p) return p; }
  for (const t of tries) { const p = parts.find((x) => x.filename && x.filename === t); if (p) return p; }
  return null;
}

function dataUri(found, state) {
  if (!found) return null;
  if (state.seen.has(found)) return state.seen.get(found);
  let bytes;
  try { bytes = decodeBody(found.part); } catch { return null; }
  if (!bytes || !bytes.length) return null;
  if (bytes.length > MAX_INLINE_BYTES || bytes.length > state.budget) return null;
  state.budget -= bytes.length;
  const uri = `data:${found.type};base64,${b64(bytes)}`;
  state.seen.set(found, uri);
  return uri;
}

// url(cid:...) in a <style> block or a style attribute. Single quotes around the data: URI so
// it can sit inside a double-quoted style attribute; base64 contains neither quote.
function cssUrls(s, ctx) {
  return String(s).replace(/url\(\s*(['"]?)\s*cid:([^'")\s]+)\s*\1\s*\)/gi, (whole, q, ref) => {
    if (ctx.cidMode === "remove") return "none";
    if (ctx.cidMode !== "inline") return whole;
    const uri = dataUri(findPart(ctx.parts, ref), ctx.state);
    return uri ? `url('${uri}')` : whole;
  });
}

/**
 * html: the stored body. opts.parts: inlineParts() of the archived .eml.
 * opts.cid:         "inline" (default) | "remove" | "keep"
 * opts.remote:      "block"  (default) | "keep"
 * opts.styleBlocks: "keep"   (default) | "remove"
 * Returns { html, remote_images }.
 */
export function renderHtml(html, opts = {}) {
  const ctx = {
    parts: opts.parts || [],
    cidMode: opts.cid || "inline",
    remoteMode: opts.remote || "block",
    state: { remote: 0, budget: MAX_INLINE_TOTAL, seen: new Map() },
  };
  let s = stripElements(String(html ?? ""), opts.styleBlocks === "remove");
  s = walkTags(s, (name, attrs) => attrPass(name, attrs, ctx));
  s = cssUrls(s, ctx);
  return { html: s, remote_images: ctx.state.remote };
}

/** The sanitiser alone: no part list, images left exactly as the sender wrote them. */
export const sanitizeHtml = (html) => renderHtml(html, { cid: "keep", remote: "keep" }).html;

/**
 * The html alternative of a reply: the author's plain text, then the attribution, then the
 * original in a blockquote. The original is sanitised exactly as the reader sanitises it,
 * with its cid: images REMOVED rather than inlined — a reply that carries the sender's
 * signature logos back to them is a reply that is 2 MB of somebody else's artwork.
 */
export function quoteHtml(text, { date, from, html } = {}) {
  const body = esc(String(text ?? "").replace(/\s+$/, ""));
  // Remote images in the quote are left alone: they are the original's, the recipient's own
  // client decides whether to load them, and rewriting them would break the quote for the
  // person who wrote it.
  //
  // <style> BLOCKS GO, though the reader keeps them. A style block is document-wide wherever
  // the recipient's client honours it, so an original with `body{display:none}` — or merely an
  // aggressive `p{color:#fff}` — would restyle the reply written above it. The reader can keep
  // them because its iframe contains nothing else; out here the quote shares a document with
  // the author's own words. Inline style= attributes stay: those are scoped to their element,
  // and they are how mail is laid out in the clients that strip <style> anyway.
  const original = renderHtml(html, { cid: "remove", remote: "keep", styleBlocks: "remove" }).html;
  return `<div style="white-space:pre-wrap;font-family:inherit">${body}</div>` +
    `<br><div>${esc(attribution({ date, from }))}</div>` +
    `<blockquote type="cite" style="border-left:2px solid #ccc;margin:0 0 0 .8ex;padding-left:1ex">` +
    `${original}</blockquote>`;
}
