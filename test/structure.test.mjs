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
