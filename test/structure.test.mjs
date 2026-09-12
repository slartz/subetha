// THE WALL, asserted.
//
// SubEtha's send_email binding carries no allowed_destination_addresses, because replying to
// a shared mailbox means replying to whoever wrote in. The compensating control is not a
// comment, it is the module graph: the code that sends to a caller-chosen address lives in
// compose.js, and compose.js is not reachable from email(). These tests read the source and
// check that, so the day someone adds a convenient import the build says so rather than the
// spam does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (f) => readFileSync(join(SRC, f), "utf8");
// The CODE of a file, with whole-line comments removed. Every comment in this worker is a
// whole line (house style), and the banners talk ABOUT env.SEND and setReject at length —
// so without this the assertions below would be about prose rather than about behaviour.
const code = (f) => read(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const files = readdirSync(SRC).filter((f) => f.endsWith(".js"));

// Relative imports only — "cloudflare:email" and friends are leaves.
function importsOf(file) {
  const s = read(file);
  const out = new Set();
  for (const m of s.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) out.add(m[1].replace(/^\.\//, ""));
  for (const m of s.matchAll(/\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g)) out.add(m[1].replace(/^\.\//, ""));
  return [...out];
}

function reachable(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const dep of importsOf(f)) stack.push(dep);
  }
  seen.delete(entry);
  return seen;
}

test("compose.js is NOT reachable from the email() path", () => {
  const graph = reachable("inbound.js");
  assert.equal(graph.has("compose.js"), false,
    `inbound.js can reach compose.js via ${[...graph].join(", ")} — the send-to-anyone capability is now inside email()`);
});

test("index.js calls handleInbound and nothing else from email()", () => {
  const s = code("index.js");
  const body = s.slice(s.indexOf("async email(message, env, ctx)"), s.indexOf("async fetch(request, env, ctx)"));
  assert.match(body, /handleInbound\(message, env, ctx\)/);
  assert.equal(/replyToMessage|composeNew|sendRaw|env\.SEND/.test(body), false,
    "email() must not name the send path at all");
  for (const f of files)
    assert.equal(/setReject\s*\(/.test(code(f)), false,
      `${f} calls setReject — a reject is a bounce, and bounce rate is one of the four dials governing the sending quota`);
});

test("compose.js is imported by index.js and by nothing else", () => {
  const importers = files.filter((f) => importsOf(f).includes("compose.js"));
  assert.deepEqual(importers, ["index.js"]);
});

test("env.SEND is touched in exactly one module", () => {
  const touchers = files.filter((f) => /env\.SEND\b/.test(code(f)));
  assert.deepEqual(touchers, ["send.js"],
    "everything that sends must go through send.js, so 'who may send' is a question about its two callers");
});

test("cloudflare: built-ins are imported only where they have to be", () => {
  const cf = Object.fromEntries(files
    .map((f) => [f, [...code(f).matchAll(/from\s+["'](cloudflare:[^"']+)["']/g)].map((m) => m[1])])
    .filter(([, v]) => v.length));
  assert.deepEqual(cf, { "mailbox-do.js": ["cloudflare:workers"], "send.js": ["cloudflare:email"] },
    "a cloudflare: import in a module makes that module untestable under node");
});

test("every route in index.js sits behind the auth check", () => {
  const s = code("index.js");
  const auth = s.indexOf('if (!identity) return json({ error: "unauthorized" }, 401);');
  assert.ok(auth > 0, "the auth gate must exist");
  // No route may be answered before it. `path`/`url` are read above the gate; a Response is
  // the thing that must not be.
  const before = s.slice(s.indexOf("export async function route"), auth);
  assert.equal(/return\s+(new Response|json\()/.test(before.replace(/return json\(\{ error: "unauthorized" \}, 401\);/, "")), false,
    "something answers before the auth check");
});

test("an unset ADMIN_SECRET cannot authenticate anything", () => {
  assert.match(code("index.js"), /if \(!env\.ADMIN_SECRET\) return false;/);
});

// ---- the permission model, asserted -------------------------------------
//
// canView/canAdmin are exercised directly in test/perm.test.mjs. What that cannot see is
// whether the ROUTES ask them. A predicate nobody calls is a permission model in the comments,
// so these read index.js and check that every route which names a mailbox or a message asks
// before it answers.

const between = (s, from, to) => {
  const i = s.indexOf(from);
  assert.ok(i >= 0, `marker not found: ${from}`);
  const j = s.indexOf(to, i);
  assert.ok(j > i, `${to} does not follow ${from}`);
  return s.slice(i, j);
};
const count = (s, needle) => s.split(needle).length - 1;

test("every mutating mailbox route checks the admin permission before it mutates", () => {
  const s = code("index.js");
  for (const [route, mutate] of [
    ['seg.length === 3 && request.method === "PUT"', "stub.upsertMailbox("],
    ['seg.length === 3 && request.method === "DELETE"', "stub.deleteMailbox("],
  ]) {
    assert.equal(count(s, mutate), 1, `${mutate} must have exactly one call site to guard`);
    assert.match(between(s, route, mutate), /canAdmin\(identity, owners\)/,
      `${mutate} is reachable without the admin check — a member could rewrite a member list`);
  }
});

test("every mailbox route that is not mutating checks the view permission", () => {
  const s = code("index.js");
  for (const [route, act] of [
    ['seg[3] === "messages" && request.method === "GET"', "stub.messages("],
    ['seg[3] === "send" && request.method === "POST"', "composeNew(env, stub, address"],
  ]) assert.match(between(s, route, act), /mayView\(stub, identity, owners, address\)/,
    `${act} is reachable without the view check`);
});

test("the message routes resolve the row and ask about ITS mailbox before answering", () => {
  const s = code("index.js");
  const guard = s.indexOf("mayView(stub, identity, owners, m.mailbox)");
  assert.ok(guard > 0, "the messages branch must ask about the mailbox the message belongs to");
  for (const answered of [
    "await withRenderedHtml(env, m)",
    "await env.MAIL.get(m.r2_key)",
    "await replyToMessage(env, stub, id, body, identity)",
  ]) assert.ok(s.indexOf(answered) > guard, `${answered} is reached before the check`);
});

test("muting is administration: creating, deleting and hiding are owner-only", () => {
  // A mute rule stops the fan-out for EVERY member of the mailbox, and hiding a message hides
  // it from everybody. Both are the member list's kind of question, not the reader's.
  const s = code("index.js");
  for (const [route, act] of [
    ['seg[3] === "rules" && request.method === "POST"', "stub.addRule("],
    ['seg[3] === "rules" && request.method === "DELETE"', "stub.deleteRule("],
    ['seg[3] === "hidden" && request.method === "POST"', "stub.setHidden("],
  ]) {
    assert.equal(count(s, act), 1, `${act} must have exactly one call site to guard`);
    assert.match(between(s, route, act), /canAdmin\(identity, owners\)/,
      `${act} is reachable without the admin check — a member could silence a mailbox for everyone`);
  }
  // Reading them is a view question: a member who cannot see the rules is a member wondering
  // where the mail went.
  assert.match(between(s, 'seg[3] === "rules" && request.method === "GET"', "stub.rules("),
    /mayView\(stub, identity, owners, address\)/,
    "the rule list names a mailbox, so it asks the same question every other such route asks");
});

test("the mailbox list is filtered by identity, never handed over whole", () => {
  const s = code("index.js");
  assert.match(s, /json\(visibleMailboxes\(await stub\.mailboxes\(\), identity, owners\)\)/);
  assert.equal(/json\(await stub\.mailboxes\(\)\)/.test(s), false,
    "the unfiltered list would tell a stranger every address in the zone");
});

test("a reply carries an html alternative only when the original had one", () => {
  const s = code("compose.js");
  assert.match(s, /html: msg\.html \? quoteHtml\(/,
    "a text-only original must be answered in text/plain, as it always was");
  const composeNew = s.slice(s.indexOf("export async function composeNew"));
  assert.equal(/quoteHtml|html:/.test(composeNew), false, "compose (new mail) stays text/plain");
  assert.deepEqual(files.filter((f) => /\bbuildMime\(\{/.test(code(f))).sort(), ["compose.js", "inbound.js"],
    "one builder, two callers — the html alternative reuses it rather than adding a second");
});

test("the reader never shows a message without the empty sandbox and the CSP", () => {
  const s = code("ui.js");
  assert.match(s, /f\.setAttribute\("sandbox", ""\)/, "the empty sandbox is the first layer");
  assert.match(s, /f\.srcdoc = "<!doctype html>" \+ \(loadRemote \? CSP_REMOTE \+ withRemote\(doc\) : CSP_BLOCKED \+ doc\)/,
    "the CSP goes at the top of the document, every time, in both branches");
  assert.equal(/srcdoc = m\.html/.test(s), false, "the stored html must never go in unrendered");
  assert.equal(count(s, "loadRemote = true"), 1,
    "exactly one thing may load a remote image, and it is the operator's click");
});
