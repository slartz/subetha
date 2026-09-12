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

// The tab icon, inline like everything else on this page: an envelope with an arrow leaving it.
// Two literal colours because a favicon inherits nothing, and percent-encoded because a raw
// "#" in a data: URI starts a fragment and would cut the document in half. It is deliberately
// the only icon link on the page — one SVG scales, and a second link is a size negotiation.
const FAVICON = "%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%235980a6%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Crect%20x%3D%222%22%20y%3D%224%22%20width%3D%2215%22%20height%3D%2211.5%22%20rx%3D%222%22%2F%3E%3Cpath%20d%3D%22M3.5%205.4%209.5%209.9%2015.5%205.4%22%2F%3E%3Cpath%20d%3D%22M8%2014.6h13M17.6%2011.2%2021.4%2014.6%2017.6%2018%22%20stroke%3D%22%23ffffff%22%20stroke-width%3D%225%22%2F%3E%3Cpath%20d%3D%22M8%2014.6h13M17.6%2011.2%2021.4%2014.6%2017.6%2018%22%20stroke-width%3D%222.4%22%2F%3E%3C%2Fsvg%3E";

export function renderUi({ identity } = {}) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SubEtha</title>
<link rel="icon" href="data:image/svg+xml,${FAVICON}">
<meta name="theme-color" content="#5980a6">
<script>
// The theme is the operator's choice, not the operating system's, and it is read HERE rather
// than in the script at the foot of the page: by the time that one runs the browser has
// already painted, and somebody who picked dark would watch the page flash white every load.
// localStorage throws outright in some privacy modes, so a stored preference is a nicety and
// never a requirement — the page is light when it cannot be asked.
try { if (localStorage.getItem("subetha-theme") === "dark") document.documentElement.setAttribute("data-theme", "dark"); } catch (e) {}
</script>
<style>${CSS}</style>

<div class="bar">
  <div class="head">
    <h1>SubEtha</h1>
    <span class="grow"></span>
    <label class="opt"><input type="checkbox" id="dark"> dark</label>
    <span class="who" id="who">${esc(identity || "")}</span>
  </div>
  <div class="row">
    <span class="grp">
      <label class="lbl" for="box">mailbox</label>
      <select id="box"></select>
    </span>
    <button id="newbox" class="primary">New mailbox…</button>
    <span class="grp grow">
      <label class="lbl" for="dn">display name</label>
      <input type="text" id="dn" class="grow" placeholder="Support" style="max-width:260px">
    </span>
    <span class="grp">
      <button id="save" class="primary">Save</button>
      <button id="del">Delete mailbox</button>
    </span>
    <span class="grow"></span>
    <button id="compose" class="primary">Compose…</button>
  </div>
  <table class="members"><tbody id="members"></tbody></table>
  <div class="row">
    <button id="addmember">+ member</button>
    <span class="note">forward requires a verified destination address on the account;
      send arrives from the mailbox address and uses the sending quota</span>
  </div>
  <table class="members"><tbody id="rules"></tbody></table>
  <div class="row"><span class="note" id="rulesnote"></span></div>
  <div class="row" id="storagerow">
    <span class="note" id="storage"></span>
    <span class="grow"></span>
    <label class="lbl" for="ret">retention</label>
    <select id="ret">
      <option value="">Keep forever</option>
      <option value="30">30 days</option>
      <option value="60">60 days</option>
      <option value="90">90 days</option>
      <option value="180">180 days</option>
      <option value="365">365 days</option>
    </select>
    <button id="purge">Delete older than…</button>
  </div>
  <div class="err" id="cfgerr"></div>
</div>

<div class="panes">
  <div class="pane">
    <h2>Messages <span id="count" class="note"></span>
      <span class="grow"></span>
      <label class="opt"><input type="checkbox" id="onlyunconf"> unconfigured only</label>
      <label class="opt"><input type="checkbox" id="showmuted"> show muted</label>
    </h2>
    <div id="list"></div>
    <div class="body"><button id="more">Load more</button></div>
  </div>
  <div class="pane">
    <h2 id="msgtitle">Nothing selected</h2>
    <div class="body" id="msg"><p class="empty">Pick a message on the left.</p></div>
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
// Coarse on purpose: a member row is answering "is this still happening", not "when exactly".
// A clock ahead of the server's would give a negative age, which reads as nonsense — clamp.
function rel(ms) {
  var n = Number(ms) || 0;
  if (!n) return "";
  var s = Math.round((Date.now() - n) / 1000);
  if (s < 0) s = 0;
  if (s < 90) return "just now";
  var m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  var h = Math.round(m / 60);
  if (h < 48) return h + "h ago";
  return Math.round(h / 24) + "d ago";
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
// Mute rules for the selected mailbox, and whether the list is asking the server for the mail
// they muted. showMuted is a SERVER-side filter, unlike "unconfigured only" which is local:
// hidden mail is left out of the response until it is asked for by name.
var rules = [], showMuted = false;
var RULES_EMPTY = "No mute rules. Open a message and use “Mute…” to stop forwarding mail like it — it is still archived and still stored, just not sent on.";
// Set from GET /api/me. It decides what this PAGE draws and nothing else — every route
// checks the same question again on the server, because a hidden button is not a permission.
var isOwner = false;
var PIXEL = ${JSON.stringify(PIXEL)};
var CSP_BLOCKED = ${JSON.stringify(CSP("data:"))};
var CSP_REMOTE = ${JSON.stringify(CSP("data: https:"))};

// ---- mailbox configuration --------------------------------------------
// What the last fan-out to this member did. A forward to an address that is not a verified
// destination throws on EVERY message, the other members still get theirs, and the failure
// is otherwise only visible by opening a message and reading its fan-out table — so it is
// said here, on the row that can be fixed. Nothing at all for a member nothing has been sent
// to yet: an absent status is not a failure.
function memberStat(last) {
  if (!last) return "";
  var t = last.error ? ' title="' + esc(last.error) + '"' : "";
  if (!last.ok) return '<span class="mstat bad"' + t + ">&#9888; " + esc(last.hint || last.error || "delivery failed") + "</span>";
  // ok with mode 'skip' is the loop guard or a member skip: nothing was sent, and saying
  // "delivered" about a message that was deliberately not sent is the one lie to avoid here.
  if (last.mode === "skip") return '<span class="mstat"' + t + ">&middot; skipped " + esc(rel(last.at)) + "</span>";
  return '<span class="mstat ok">&#10003; delivered ' + esc(rel(last.at)) + "</span>";
}
function memberTint(last) {
  if (!last) return "";
  if (!last.ok) return "m-bad";
  return last.mode === "skip" ? "m-skip" : "m-ok";
}
function memberRow(email, mode, last) {
  if (!isOwner) {
    var ro = document.createElement("tr");
    ro.className = memberTint(last);
    ro.innerHTML = "<td>" + esc(email || "") + '</td><td class="note">' + esc(mode || "") + "</td><td>" +
      memberStat(last) + "</td><td></td>";
    return ro;
  }
  // The two radios must share a name to be mutually exclusive, and that name must be unique
  // to the row or every row in the table becomes one radio group.
  var nm = "mode" + Math.random().toString(36).slice(2);
  var tr = document.createElement("tr");
  tr.className = memberTint(last);
  tr.innerHTML =
    '<td><input type="email" class="m-email" value="' + esc(email || "") + '" placeholder="someone@example.com"></td>' +
    '<td><label><input type="radio" class="m-fwd" name="' + nm + '"' + (mode !== "send" ? " checked" : "") + '> forward</label> ' +
    '<label><input type="radio" class="m-snd" name="' + nm + '"' + (mode === "send" ? " checked" : "") + '> send</label></td>' +
    "<td>" + memberStat(last) + "</td>" +
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
// Bytes as an owner reads them. One decimal, because "0 MB" for 400 KB of mail reads as
// nothing stored at all and the whole point of the line is to say how much there is.
function size(bytes) {
  var n = Number(bytes) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
// What this mailbox holds, and how old the oldest of it is — the two numbers a retention
// decision is made from, said in one line above the control that acts on them.
function showStorage(b) {
  var s = (b && b.storage) || null;
  if (!s || !s.messages) { el("storage").textContent = "No messages stored."; return; }
  // The stored sizes, which is what the retention decision is about. R2's own usage for the same
  // mailbox is close to this and not identical — that caveat belongs in the README, not on a line
  // an owner reads to decide whether to keep 90 days or 365.
  el("storage").textContent = s.messages + (s.messages === 1 ? " message · " : " messages · ") + size(s.bytes) +
    (s.oldest_at ? " · oldest " + new Date(s.oldest_at).toISOString().slice(0, 10) : "");
}
function showConfig(b) {
  el("dn").value = (b && b.display_name) || "";
  el("ret").value = b && b.retention_days ? String(b.retention_days) : "";
  showStorage(b);
  var tb = el("members"); tb.innerHTML = "";
  var ms = (b && b.members) || [];
  for (var i = 0; i < ms.length; i++) tb.appendChild(memberRow(ms[i].email, ms[i].mode, ms[i].last));
  if (!ms.length && isOwner) tb.appendChild(memberRow("", "forward"));
}
// Deleting mail is the one irreversible thing in SubEtha, so it is two steps and the second one
// states a number the SERVER counted: the dry run asks what would go, and only what comes back
// from it is put in front of the operator. A confirm that says "some messages" is a confirm
// nobody reads.
function purgeModal() {
  if (!cur) return toast("No mailbox selected");
  var d = document.createElement("div");
  d.className = "modal";
  d.innerHTML = '<div class="card"><h2>Delete old mail from ' + esc(cur) + "</h2>" +
    '<p class="note">This deletes stored messages older than the period you pick — both received and sent — together with their archived copies in R2. It cannot be undone, and it is the only thing in SubEtha that removes mail. You will be told how much before anything goes.</p>' +
    '<div class="row"><label class="lbl" for="pdays">older than</label><select id="pdays">' +
    '<option value="30">30 days</option><option value="60">60 days</option>' +
    '<option value="90">90 days</option><option value="180">180 days</option>' +
    '<option value="365" selected>365 days</option></select>' +
    '<button id="pok" class="primary">Check…</button><button id="pcancel">Cancel</button>' +
    '<span class="err" id="perr"></span></div></div>';
  document.body.appendChild(d);
  el("pcancel").onclick = function () { d.remove(); };
  el("pok").onclick = async function () {
    el("pok").disabled = true; el("perr").textContent = "";
    var days = el("pdays").value;
    var base = "/api/mailboxes/" + encodeURIComponent(cur) + "/purge";
    try {
      var dry = await api(base + "?dry_run=1", { method: "POST", body: { older_than_days: Number(days) } });
      if (!dry.deleted) { d.remove(); return toast("Nothing older than " + days + " days"); }
      if (!confirm("Delete " + dry.deleted + " message" + (dry.deleted === 1 ? "" : "s") + " (" + size(dry.bytes) +
                   ") older than " + days + " days from " + cur + "?\\n\\nThe archived copies go too. This cannot be undone.")) {
        el("pok").disabled = false; return;
      }
      var r = await api(base, { method: "POST", body: { older_than_days: Number(days) } });
      d.remove();
      // A purge takes a batch at a time, so say what actually went rather than what was asked
      // for — and say it plainly when there is more left.
      toast("Deleted " + r.deleted + " of " + dry.deleted + " (" + size(r.bytes) + ")" +
            (r.r2_failed ? " — " + r.r2_failed + " archived copies could not be removed and were kept" : "") +
            (r.deleted < dry.deleted ? " — run it again for the rest" : ""));
      await loadBoxes(cur);
    } catch (e) { el("perr").textContent = String(e.message || e); el("pok").disabled = false; }
  };
}
// ---- mute rules --------------------------------------------------------
// A rule reads as the sentence it is, because "subject / black friday" in a table is a thing
// an owner has to decode a month later. The pattern is shown as stored: lowercased, literal,
// and never a regular expression.
function ruleLabel(r) {
  if (r.field === "from") return "mute from " + r.pattern;
  if (r.field === "from_domain") return "mute domain @" + r.pattern;
  if (r.field === "subject") return "mute subject containing “" + r.pattern + "”";
  if (r.field === "list_id") return "mute list-id containing “" + r.pattern + "”";
  return "mute " + r.field + " " + r.pattern;
}
function ruleRow(r) {
  var tr = document.createElement("tr");
  var made = r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : "";
  tr.innerHTML =
    "<td>#" + r.id + " " + esc(ruleLabel(r)) + "</td>" +
    '<td class="note">' + (r.hits || 0) + " muted</td>" +
    '<td class="note">' + esc(made + (r.created_by ? " by " + r.created_by : "")) + "</td>" +
    "<td>" + (isOwner ? '<button class="link r-del">remove</button>' : "") + "</td>";
  if (isOwner) tr.querySelector(".r-del").onclick = function () { removeRule(r.id); };
  return tr;
}
async function loadRules() {
  var host = el("rules");
  host.innerHTML = "";
  rules = [];
  if (!cur) { el("rulesnote").textContent = RULES_EMPTY; return; }
  try { rules = await api("/api/mailboxes/" + encodeURIComponent(cur) + "/rules"); }
  catch (e) { el("rulesnote").textContent = String(e.message || e); return; }
  for (var i = 0; i < rules.length; i++) host.appendChild(ruleRow(rules[i]));
  el("rulesnote").textContent = rules.length
    ? rules.length + (rules.length === 1 ? " mute rule" : " mute rules") + " — matching mail is stored and readable under “show muted”, and is forwarded to nobody."
    : RULES_EMPTY;
}
// The messages it already muted STAY muted: removing a rule stops it applying from now on,
// and un-hiding is a per-message decision. Said out loud in the confirm, because the opposite
// is what a person might assume.
async function removeRule(id) {
  if (!confirm("Remove rule #" + id + "? Messages it already muted stay muted.")) return;
  try {
    await api("/api/mailboxes/" + encodeURIComponent(cur) + "/rules/" + id, { method: "DELETE" });
    toast("Rule removed");
    await loadRules();
  } catch (e) { el("cfgerr").textContent = String(e.message || e); }
}

// A member sees the configuration and cannot change it: the editor's controls are removed
// rather than disabled, so there is nothing to click that would come back 403.
function applyRole() {
  // storagerow goes whole: retention and the purge button are owner-only, and a storage line on
  // its own, under two controls a member cannot use, is a line asking a question it cannot answer.
  var ids = ["newbox", "save", "del", "addmember", "storagerow"];
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
    el("list").innerHTML = '<div class="body empty">' + (isOwner
      ? "No mailbox has received anything yet, and none is configured. Use “New mailbox…”."
      : "No mailboxes. You are not on any mailbox’s member list — ask an owner to add you.") + "</div>";
    cur = null; showConfig(null); await loadRules(); return;
  }
  cur = (keep && boxes.some(function (b) { return b.address === keep; })) ? keep : boxes[0].address;
  sb.value = cur;
  showConfig(boxes.filter(function (b) { return b.address === cur; })[0]);
  await loadRules();
  await loadMessages(true);
}

// ---- message list ------------------------------------------------------
// An outbound row's fan-out rows are its envelope recipients, not a fan-out to members —
// "fan-out 2/2" on something this mailbox sent reads as if the reply went to the member list.
function fanoutCell(m) {
  if (!m.fanout_total) return "";
  var bad = m.fanout_total - m.fanout_ok;
  var label = m.direction === "out" ? "sent " : "fan-out ";
  return '<span class="badge' + (bad ? " bad" : "") + '">' + label + m.fanout_ok + "/" + m.fanout_total + "</span>";
}
function renderList() {
  var only = el("onlyunconf").checked;
  var shown = only ? msgs.filter(function (m) { return m.unconfigured; }) : msgs;
  el("count").textContent = shown.length + " shown";
  var host = el("list");
  host.innerHTML = "";
  if (!shown.length) { host.innerHTML = '<div class="body empty">Nothing here.</div>'; return; }
  for (var i = 0; i < shown.length; i++) {
    (function (m) {
      var b = document.createElement("button");
      b.className = "msg" + (sel && sel.id === m.id ? " sel" : "");
      b.innerHTML =
        '<div class="l1"><span class="badge ' + (m.direction === "out" ? "out" : "in") + '">' + m.direction + "</span>" +
        '<span class="subj">' + esc(m.subject || "(no subject)") + "</span>" +
        (m.unconfigured ? '<span class="badge unconf">unconfigured</span>' : "") +
        (m.hidden ? '<span class="badge muted">muted' + (m.muted_by ? " &middot; rule #" + m.muted_by : "") + "</span>" : "") + "</div>" +
        '<div class="l2"><span class="grow">' + esc(m.direction === "out" ? "to " + (m.to_addrs || "") : (m.from_name || m.from_addr || "")) + "</span>" +
        (m.has_attachments ? '<span class="badge">att</span>' : "") + fanoutCell(m) +
        '<span class="when">' + esc(when(m.received_at, m.date_hdr)) + "</span></div>";
      b.onclick = function () { openMsg(m.id).catch(function (e) { toast(String(e.message || e)); }); };
      host.appendChild(b);
    })(shown[i]);
  }
}
async function loadMessages(reset) {
  if (!cur) return;
  if (reset) { msgs = []; oldest = 0; sel = null; el("msg").innerHTML = '<p class="empty">Pick a message on the left.</p>'; el("msgtitle").textContent = "Nothing selected"; }
  var q = "/api/mailboxes/" + encodeURIComponent(cur) + "/messages?limit=50" + (oldest ? "&before=" + oldest : "") +
          (showMuted ? "&hidden=1" : "");
  var page = await api(q);
  msgs = msgs.concat(page);
  if (page.length) oldest = page[page.length - 1].id;
  el("more").style.display = page.length === 50 ? "" : "none";
  renderList();
}

// ---- one message -------------------------------------------------------
function kv(k, v) { return v ? '<tr><td class="k">' + esc(k) + "</td><td>" + esc(v) + "</td></tr>" : ""; }
// The rule that muted this message may have been removed since — the row keeps its id either
// way, so say which of the two this is rather than showing a dangling number.
function mutedNote(m) {
  if (!m.muted_by) return "hidden by an owner — nothing was forwarded";
  for (var i = 0; i < rules.length; i++)
    if (rules[i].id === m.muted_by) return ruleLabel(rules[i]) + " — nothing was forwarded";
  return "the rule that muted it has since been removed — nothing was forwarded";
}
function fanoutTable(f) {
  if (!f || !f.length) return "";
  var s = '<h3 class="sec">Fan-out</h3><table class="kv">';
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
    (m.hidden ? '<tr><td class="k">state</td><td><span class="badge muted">muted' + (m.muted_by ? " &middot; rule #" + m.muted_by : " by hand") +
      "</span> " + esc(mutedNote(m)) + "</td></tr>" : "") +
    attHtml + "</table>";

  // No Reply on an outbound row: the only address to reply to there is the mailbox itself,
  // which would come straight back through Email Routing and be fanned out again.
  var n = m.remote_images || 0;
  var buttons = '<div class="row actions">' +
    (m.direction === "out" ? "" : '<button id="breply">Reply</button>') +
    (m.html ? '<button id="bhtml">' + (showHtml ? "Show text" : "Show HTML") + "</button>" : "") +
    (showHtml && !loadRemote && n ? '<button id="bremote">Load ' + n + " remote image" + (n === 1 ? "" : "s") + "</button>" : "") +
    (m.r2_key ? '<a href="/api/messages/' + m.id + '/raw"><button>Download raw</button></a>' : "") +
    // Muting is about mail that KEEPS arriving, so it is offered on inbound messages only —
    // an outbound row's sender is the mailbox itself, and a rule on that would mute the
    // mailbox's own replies coming back through Email Routing.
    (isOwner && m.direction !== "out" ? '<button id="bmute">Mute…</button>' : "") +
    (isOwner && m.hidden ? '<button id="bunhide">Unhide</button>' : "") +
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
  if (el("bmute")) el("bmute").onclick = muteModal;
  if (el("bunhide")) el("bunhide").onclick = function () { setHidden(m.id, 0); };
}

// Per message, and it does not touch the rule: the next message matching it is muted again.
async function setHidden(id, hidden) {
  try {
    await api("/api/messages/" + id + "/hidden", { method: "POST", body: { hidden: hidden } });
    toast(hidden ? "Hidden" : "Unhidden");
    await loadMessages(true);
  } catch (e) { toast(String(e.message || e)); }
}

// Three options, all prefilled from this message and all editable, because the useful pattern
// is usually a shortening of what is offered — "newsletter" out of a whole subject line. The
// modal says what a mute does and does not do: the mail keeps arriving and keeps being stored,
// and it stops being forwarded to anybody.
function muteModal() {
  var m = sel;
  if (!m || !cur) return;
  var from = (m.from_addr || "").toLowerCase();
  var domain = from.indexOf("@") >= 0 ? from.split("@")[1] : "";
  var subject = (m.subject || "").toLowerCase();
  var opts = [];
  if (from) opts.push(["from", from, "sender " + from]);
  if (domain) opts.push(["from_domain", domain, "domain @" + domain]);
  if (subject) opts.push(["subject", subject, "subject contains “" + subject + "”"]);
  if (!opts.length) return toast("Nothing on this message to mute on");
  var radios = "";
  for (var i = 0; i < opts.length; i++)
    radios += '<div class="row"><label><input type="radio" name="mutefield" class="mf" value="' +
      opts[i][0] + '"' + (i ? "" : " checked") + "> " + esc(opts[i][2]) + "</label></div>";
  var d = document.createElement("div");
  d.className = "modal";
  d.innerHTML = '<div class="card"><h2>Mute mail like this</h2>' +
    '<p class="note">Matching mail still arrives, is still archived and is still stored — it is not forwarded to anyone, and it is hidden from the list until you tick “show muted”. Messages already stored that match are hidden too.</p>' +
    radios +
    '<div class="row"><label class="lbl" for="mpat">pattern</label><input type="text" id="mpat" class="grow"></div>' +
    '<div class="row"><button id="mok" class="primary">Mute</button><button id="mcancel">Cancel</button>' +
    '<span class="err" id="merr"></span></div></div>';
  document.body.appendChild(d);
  var fields = d.querySelectorAll(".mf");
  function pick() {
    for (var i = 0; i < fields.length; i++) if (fields[i].checked) el("mpat").value = opts[i][1];
  }
  for (var j = 0; j < fields.length; j++) fields[j].onchange = pick;
  pick();
  el("mcancel").onclick = function () { d.remove(); };
  el("mok").onclick = async function () {
    el("mok").disabled = true; el("merr").textContent = "";
    var field = "";
    for (var i = 0; i < fields.length; i++) if (fields[i].checked) field = fields[i].value;
    try {
      var r = await api("/api/mailboxes/" + encodeURIComponent(cur) + "/rules",
        { method: "POST", body: { field: field, pattern: el("mpat").value } });
      d.remove();
      toast("Muted" + (r.hidden_now ? " — hid " + r.hidden_now + " existing" : ""));
      await loadRules();
      await loadMessages(true);
    } catch (e) { el("merr").textContent = String(e.message || e); el("mok").disabled = false; }
  };
}
function replyBox() {
  var m = sel;
  el("replybox").innerHTML =
    '<h3 class="sec">Reply as ' + esc(m.mailbox) + "</h3>" +
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
// A page preference, not mailbox configuration: it never goes near the server, it belongs to
// this browser alone, and the attribute it sets is the ONLY thing that makes the page dark.
el("dark").checked = document.documentElement.getAttribute("data-theme") === "dark";
el("dark").onchange = function () {
  var on = el("dark").checked;
  if (on) document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  try { localStorage.setItem("subetha-theme", on ? "dark" : "light"); } catch (e) {}
};
el("box").onchange = async function () { cur = el("box").value; showConfig(boxes.filter(function (b) { return b.address === cur; })[0]); await loadRules(); await loadMessages(true); };
el("addmember").onclick = function () { el("members").appendChild(memberRow("", "forward")); };
el("onlyunconf").onchange = renderList;
// Unlike "unconfigured only", this one refetches: hidden mail is not in the page to filter.
el("showmuted").onchange = function () {
  showMuted = el("showmuted").checked;
  loadMessages(true).catch(function (e) { toast(String(e.message || e)); });
};
el("more").onclick = function () { loadMessages(false).catch(function (e) { toast(String(e.message || e)); }); };
el("compose").onclick = composeModal;
el("purge").onclick = purgeModal;
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
    // Retention goes with the save because it is configuration, not an action: the PUT carries
    // the whole of it, and an empty select is null — keep forever.
    await api("/api/mailboxes/" + encodeURIComponent(cur), { method: "PUT", body: {
      display_name: el("dn").value, members: readMembers(),
      retention_days: el("ret").value ? Number(el("ret").value) : null } });
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
