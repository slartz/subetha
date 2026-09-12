// The page. One HTML document, inline CSS and inline JS, vanilla — no framework, no build
// step, and NO EXTERNAL RESOURCE OF ANY KIND: not a font, not a CDN, not an icon sprite.
// The only thing between this page and every mailbox in the zone is the Access login, and a
// third-party script tag on it would be a second door.
//
// Structure: the CSS lives in theme.js, the markup here, and the page talks to its own
// /api/* routes with credentials:'include' so the CF_Authorization cookie rides along.
//
// The client script below uses string concatenation rather than template literals on
// purpose — this file is itself one big template literal, and a stray ${ } in the client
// code would be evaluated here, at render time, on the server.
import { CSS } from "./theme.js";
import { PIXEL } from "./html-render.js";

const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// The policy the reader puts at the top of the iframe document, BELOW the empty sandbox
// rather than instead of it. Remote images are off until the operator asks: a remote image in
// mail is a read receipt with a URL, and it was the sender who chose it. Built here and
// interpolated into the client script, because a quote inside a quote inside this file's
// template literal is how that string gets broken by the next person to edit it.
const CSP = (img) => `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
  `img-src ${img}; style-src 'unsafe-inline'; font-src data:">`;

export function renderUi({ identity } = {}) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SubEtha</title>
<style>${CSS}</style>

<div class="bar">
  <h1>SubEtha</h1>
  <span class="who" id="who">${esc(identity || "")}</span>
  <div class="row">
    <label class="lbl" for="box">mailbox</label>
    <select id="box"></select>
    <button id="newbox">New mailbox…</button>
    <label class="lbl" for="dn">display name</label>
    <input type="text" id="dn" class="grow" placeholder="Support" style="max-width:260px">
    <button id="save" class="primary">Save</button>
    <button id="del">Delete mailbox</button>
    <span class="grow"></span>
    <button id="compose">Compose…</button>
  </div>
  <table class="members"><tbody id="members"></tbody></table>
  <div class="row">
    <button id="addmember">+ member</button>
    <span class="note">forward requires a verified destination address on the account;
      send arrives from the mailbox address and uses the sending quota</span>
  </div>
  <div class="err" id="cfgerr"></div>
</div>

<div class="panes">
  <div class="pane">
    <h2>Messages <span id="count" class="note"></span>
      <label class="note" style="float:right"><input type="checkbox" id="onlyunconf"> unconfigured only</label>
    </h2>
    <div id="list"></div>
    <div class="body"><button id="more">Load more</button></div>
  </div>
  <div class="pane">
    <h2 id="msgtitle">Nothing selected</h2>
    <div class="body" id="msg"><p class="note">Pick a message on the left.</p></div>
  </div>
</div>

<div id="toast"></div>

<script>
// ---- tiny helpers ------------------------------------------------------
function esc(x) {
  return String(x == null ? "" : x).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function el(id) { return document.getElementById(id); }
function toast(t) {
  var n = el("toast"); n.textContent = t; n.style.display = "block";
  clearTimeout(n._t); n._t = setTimeout(function () { n.style.display = "none"; }, 3200);
}
function when(ms, dateHdr) {
  if (dateHdr) return dateHdr.replace(/\\s*\\([^)]*\\)\\s*$/, "");
  return ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z" : "";
}
async function api(path, opts) {
  var o = opts || {};
  o.credentials = "include";
  if (o.body !== undefined) {
    o.headers = Object.assign({ "content-type": "application/json" }, o.headers || {});
    o.body = JSON.stringify(o.body);
  }
  var r = await fetch(path, o);
  var ct = r.headers.get("content-type") || "";
  var data = ct.indexOf("json") >= 0 ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data && data.error ? data.error : "HTTP " + r.status);
  return data;
}

// ---- state -------------------------------------------------------------
var boxes = [], cur = null, msgs = [], sel = null, oldest = 0, showHtml = false, loadRemote = false;
// Set from GET /api/me. It decides what this PAGE draws and nothing else — every route
// checks the same question again on the server, because a hidden button is not a permission.
var isOwner = false;
var PIXEL = ${JSON.stringify(PIXEL)};
var CSP_BLOCKED = ${JSON.stringify(CSP("data:"))};
var CSP_REMOTE = ${JSON.stringify(CSP("data: https:"))};

// ---- mailbox configuration --------------------------------------------
function memberRow(email, mode) {
  if (!isOwner) {
    var ro = document.createElement("tr");
    ro.innerHTML = "<td>" + esc(email || "") + '</td><td class="note">' + esc(mode || "") + "</td><td></td>";
    return ro;
  }
  // The two radios must share a name to be mutually exclusive, and that name must be unique
  // to the row or every row in the table becomes one radio group.
  var nm = "mode" + Math.random().toString(36).slice(2);
  var tr = document.createElement("tr");
  tr.innerHTML =
    '<td><input type="email" class="m-email" style="width:260px" value="' + esc(email || "") + '" placeholder="someone@example.com"></td>' +
    '<td><label><input type="radio" class="m-fwd" name="' + nm + '"' + (mode !== "send" ? " checked" : "") + '> forward</label> ' +
    '<label><input type="radio" class="m-snd" name="' + nm + '"' + (mode === "send" ? " checked" : "") + '> send</label></td>' +
    '<td><button class="link m-del">remove</button></td>';
  tr.querySelector(".m-del").onclick = function () { tr.remove(); };
  return tr;
}
function readMembers() {
  var out = [];
  var rows = el("members").querySelectorAll("tr");
  for (var i = 0; i < rows.length; i++) {
    var f = rows[i].querySelector(".m-email");
    if (!f) continue;                      // a read-only row: this caller is not an owner
    var e = f.value.trim().toLowerCase();
    if (!e) continue;
    out.push({ email: e, mode: rows[i].querySelector(".m-snd").checked ? "send" : "forward" });
  }
  return out;
}
function showConfig(b) {
  el("dn").value = (b && b.display_name) || "";
  var tb = el("members"); tb.innerHTML = "";
  var ms = (b && b.members) || [];
  for (var i = 0; i < ms.length; i++) tb.appendChild(memberRow(ms[i].email, ms[i].mode));
  if (!ms.length && isOwner) tb.appendChild(memberRow("", "forward"));
}
// A member sees the configuration and cannot change it: the editor's controls are removed
// rather than disabled, so there is nothing to click that would come back 403.
function applyRole() {
  var ids = ["newbox", "save", "del", "addmember"];
  for (var i = 0; i < ids.length; i++) if (el(ids[i])) el(ids[i]).style.display = isOwner ? "" : "none";
  el("dn").disabled = !isOwner;
  el("who").textContent = el("who").textContent + (isOwner ? " · owner" : "");
}
function boxLabel(b) {
  var s = b.address;
  if (!b.configured) s += "  (unconfigured)";
  else s += "  (" + b.member_count + " member" + (b.member_count === 1 ? "" : "s") + ")";
  return s;
}
async function loadBoxes(keep) {
  boxes = await api("/api/mailboxes");
  var sb = el("box"); sb.innerHTML = "";
  for (var i = 0; i < boxes.length; i++) {
    var o = document.createElement("option");
    o.value = boxes[i].address; o.textContent = boxLabel(boxes[i]);
    sb.appendChild(o);
  }
  if (!boxes.length) {
    el("list").innerHTML = '<div class="body note">' + (isOwner
      ? "No mailbox has received anything yet, and none is configured. Use “New mailbox…”."
      : "No mailboxes. You are not on any mailbox’s member list — ask an owner to add you.") + "</div>";
    showConfig(null); return;
  }
  cur = (keep && boxes.some(function (b) { return b.address === keep; })) ? keep : boxes[0].address;
  sb.value = cur;
  showConfig(boxes.filter(function (b) { return b.address === cur; })[0]);
  await loadMessages(true);
}

// ---- message list ------------------------------------------------------
function fanoutCell(m) {
  if (!m.fanout_total) return "";
  var bad = m.fanout_total - m.fanout_ok;
  return '<span class="badge' + (bad ? " bad" : "") + '">fan-out ' + m.fanout_ok + "/" + m.fanout_total + "</span>";
}
function renderList() {
  var only = el("onlyunconf").checked;
  var shown = only ? msgs.filter(function (m) { return m.unconfigured; }) : msgs;
  el("count").textContent = shown.length + " shown";
  var host = el("list");
  host.innerHTML = "";
  if (!shown.length) { host.innerHTML = '<div class="body note">Nothing here.</div>'; return; }
  for (var i = 0; i < shown.length; i++) {
    (function (m) {
      var b = document.createElement("button");
      b.className = "msg" + (sel && sel.id === m.id ? " sel" : "");
      b.innerHTML =
        '<div class="l1"><span class="badge ' + (m.direction === "out" ? "out" : "in") + '">' + m.direction + "</span>" +
        '<span class="subj">' + esc(m.subject || "(no subject)") + "</span>" +
        (m.unconfigured ? '<span class="badge unconf">unconfigured</span>' : "") + "</div>" +
        '<div class="l2"><span class="grow">' + esc(m.direction === "out" ? "to " + (m.to_addrs || "") : (m.from_name || m.from_addr || "")) + "</span>" +
        (m.has_attachments ? '<span class="badge">att</span>' : "") + fanoutCell(m) +
        "<span>" + esc(when(m.received_at, m.date_hdr)) + "</span></div>";
      b.onclick = function () { openMsg(m.id).catch(function (e) { toast(String(e.message || e)); }); };
      host.appendChild(b);
    })(shown[i]);
  }
}
async function loadMessages(reset) {
  if (!cur) return;
  if (reset) { msgs = []; oldest = 0; sel = null; el("msg").innerHTML = '<p class="note">Pick a message on the left.</p>'; el("msgtitle").textContent = "Nothing selected"; }
  var q = "/api/mailboxes/" + encodeURIComponent(cur) + "/messages?limit=50" + (oldest ? "&before=" + oldest : "");
  var page = await api(q);
  msgs = msgs.concat(page);
  if (page.length) oldest = page[page.length - 1].id;
  el("more").style.display = page.length === 50 ? "" : "none";
  renderList();
}

// ---- one message -------------------------------------------------------
function kv(k, v) { return v ? '<tr><td class="k">' + esc(k) + "</td><td>" + esc(v) + "</td></tr>" : ""; }
function fanoutTable(f) {
  if (!f || !f.length) return "";
  var s = '<h3 style="font-size:14px;margin:0 0 4px">Fan-out</h3><table class="kv">';
  for (var i = 0; i < f.length; i++) {
    s += '<tr><td class="k">' + esc(f[i].member || "—") + "</td><td>" +
         '<span class="badge' + (f[i].ok ? "" : " bad") + '">' + esc(f[i].mode) + (f[i].ok ? " ok" : " FAILED") + "</span> " +
         esc(f[i].error || "") + "</td></tr>";
  }
  return s + "</table>";
}
async function openMsg(id) {
  sel = await api("/api/messages/" + id);
  // HTML FIRST when there is any. The html part is what the sender laid out and what every
  // other mail client shows; the derived text is the fallback, not the default.
  showHtml = !!sel.html;
  loadRemote = false;
  renderList();
  render();
}
// Undo the neutralising, once, because the operator asked. The two replacements are exact
// strings this worker wrote itself in html-render.js, in that order.
function withRemote(s) {
  return s.split(' src="' + PIXEL + '"').join("").split("data-remote-src=").join("src=");
}
function render() {
  var m = sel;
  el("msgtitle").textContent = m.subject || "(no subject)";
  var atts = [];
  try { atts = JSON.parse(m.attachments_json || "[]") || []; } catch (e) { atts = []; }
  var attHtml = "";
  for (var i = 0; i < atts.length; i++) {
    attHtml += '<tr><td class="k">attachment</td><td>' + esc(atts[i].filename || atts[i].note || "(unnamed)") +
               ' <span class="note">' + esc(atts[i].type || "") + " " + (atts[i].size || 0) + " bytes</span></td></tr>";
  }
  var head = "<table class='kv'>" +
    kv("direction", m.direction === "out" ? "outgoing" + (m.sent_by ? " — sent by " + m.sent_by : "") : "incoming") +
    kv("from", (m.from_name ? m.from_name + " " : "") + "<" + (m.from_addr || "") + ">") +
    kv("reply-to", m.reply_to) + kv("to", m.to_addrs) + kv("cc", m.cc_addrs) +
    kv("date", when(m.received_at, m.date_hdr)) + kv("message-id", m.message_id) +
    kv("in-reply-to", m.in_reply_to) + kv("size", m.size ? m.size + " bytes" : "") +
    (m.unconfigured ? '<tr><td class="k">state</td><td><span class="badge unconf">arrived for a mailbox with no configuration — nothing was forwarded</span></td></tr>' : "") +
    attHtml + "</table>";

  // No Reply on an outbound row: the only address to reply to there is the mailbox itself,
  // which would come straight back through Email Routing and be fanned out again.
  var n = m.remote_images || 0;
  var buttons = '<div class="row">' +
    (m.direction === "out" ? "" : '<button id="breply">Reply</button>') +
    (m.html ? '<button id="bhtml">' + (showHtml ? "Show text" : "Show HTML") + "</button>" : "") +
    (showHtml && !loadRemote && n ? '<button id="bremote">Load ' + n + " remote image" + (n === 1 ? "" : "s") + "</button>" : "") +
    (m.r2_key ? '<a href="/api/messages/' + m.id + '/raw"><button>Download raw</button></a>' : "") +
    "</div>";

  el("msg").innerHTML = head + buttons +
    (showHtml && m.render_note ? '<div class="note">' + esc(m.render_note) + "</div>" : "") +
    (showHtml ? '<iframe class="html" id="frame"></iframe>' : '<pre class="text">' + esc(m.text || "(no text body)") + "</pre>") +
    fanoutTable(m.fanout) +
    '<div id="replybox"></div>';

  if (showHtml) {
    var f = el("frame");
    // Empty sandbox: no scripts, no same-origin, no forms, no navigation. The HTML in here
    // was written by whoever sent the message. The CSP below it is the second layer and the
    // server's sanitiser is the third; the doctype keeps the document out of quirks mode.
    f.setAttribute("sandbox", "");
    var doc = m.html_rendered == null ? (m.html || "") : m.html_rendered;
    f.srcdoc = "<!doctype html>" + (loadRemote ? CSP_REMOTE + withRemote(doc) : CSP_BLOCKED + doc);
  }
  if (el("bhtml")) el("bhtml").onclick = function () { showHtml = !showHtml; loadRemote = false; render(); };
  // One way only. Remote images are never loaded without this click, and clicking it is about
  // this message in this pane — reopening the message blocks them again.
  if (el("bremote")) el("bremote").onclick = function () { loadRemote = true; render(); };
  if (el("breply")) el("breply").onclick = replyBox;
}
function replyBox() {
  var m = sel;
  el("replybox").innerHTML =
    '<h3 style="font-size:14px;margin:8px 0 4px">Reply as ' + esc(m.mailbox) + "</h3>" +
    '<div class="row"><label class="lbl">cc</label><input type="text" id="rcc" class="grow" placeholder="optional, comma separated"></div>' +
    '<textarea id="rtext" placeholder="Your reply. The original is quoted underneath automatically."></textarea>' +
    '<div class="row"><button id="rsend" class="primary">Send reply</button><span class="err" id="rerr"></span></div>';
  el("rtext").focus();
  el("rsend").onclick = async function () {
    el("rsend").disabled = true; el("rerr").textContent = "";
    try {
      var row = await api("/api/messages/" + m.id + "/reply", { method: "POST", body: { text: el("rtext").value, cc: el("rcc").value } });
      var bad = (row.fanout || []).filter(function (f) { return !f.ok; });
      toast(bad.length ? "Stored, but " + bad.length + " recipient(s) failed" : "Sent");
      await loadMessages(true);
    } catch (e) { el("rerr").textContent = String(e.message || e); }
    el("rsend").disabled = false;
  };
}

// ---- compose -----------------------------------------------------------
function composeModal() {
  if (!cur) return toast("No mailbox selected");
  var d = document.createElement("div");
  d.className = "modal";
  d.innerHTML = '<div class="card"><h2>New message from ' + esc(cur) + "</h2>" +
    '<div class="row"><label class="lbl">to</label><input type="text" id="cto" class="grow"></div>' +
    '<div class="row"><label class="lbl">cc</label><input type="text" id="ccc" class="grow"></div>' +
    '<div class="row"><label class="lbl">subject</label><input type="text" id="csub" class="grow"></div>' +
    '<textarea id="ctext"></textarea>' +
    '<div class="row"><button id="csend" class="primary">Send</button><button id="ccancel">Cancel</button>' +
    '<span class="err" id="cerr"></span></div></div>';
  document.body.appendChild(d);
  el("ccancel").onclick = function () { d.remove(); };
  el("csend").onclick = async function () {
    el("csend").disabled = true; el("cerr").textContent = "";
    try {
      await api("/api/mailboxes/" + encodeURIComponent(cur) + "/send", { method: "POST", body: {
        to: el("cto").value, cc: el("ccc").value, subject: el("csub").value, text: el("ctext").value } });
      toast("Sent"); d.remove(); await loadMessages(true);
    } catch (e) { el("cerr").textContent = String(e.message || e); el("csend").disabled = false; }
  };
}

// ---- wiring ------------------------------------------------------------
el("box").onchange = async function () { cur = el("box").value; showConfig(boxes.filter(function (b) { return b.address === cur; })[0]); await loadMessages(true); };
el("addmember").onclick = function () { el("members").appendChild(memberRow("", "forward")); };
el("onlyunconf").onchange = renderList;
el("more").onclick = function () { loadMessages(false).catch(function (e) { toast(String(e.message || e)); }); };
el("compose").onclick = composeModal;
el("newbox").onclick = function () {
  var a = prompt("Mailbox address (it must already have an Email Routing rule pointing at SubEtha):");
  if (!a) return;
  a = a.trim().toLowerCase();
  var o = document.createElement("option"); o.value = a; o.textContent = a + "  (new)";
  el("box").appendChild(o); el("box").value = a; cur = a; showConfig(null);
  msgs = []; oldest = 0; renderList();
};
el("save").onclick = async function () {
  el("cfgerr").textContent = "";
  try {
    await api("/api/mailboxes/" + encodeURIComponent(cur), { method: "PUT", body: { display_name: el("dn").value, members: readMembers() } });
    toast("Saved"); await loadBoxes(cur);
  } catch (e) { el("cfgerr").textContent = String(e.message || e); }
};
el("del").onclick = async function () {
  if (!cur || !confirm("Remove the configuration for " + cur + "? Stored messages are kept.")) return;
  try { await api("/api/mailboxes/" + encodeURIComponent(cur), { method: "DELETE" }); toast("Deleted"); await loadBoxes(null); }
  catch (e) { el("cfgerr").textContent = String(e.message || e); }
};

// /api/me first: what this page draws depends on the answer, and drawing the editor for
// somebody who cannot use it is how a UI teaches people to expect a 403.
(async function () {
  try { isOwner = !!(await api("/api/me")).is_owner; } catch (e) { isOwner = false; }
  applyRole();
  await loadBoxes(null);
})().catch(function (e) { el("cfgerr").textContent = String(e.message || e); });
</script>`;
}
