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

test("compose.js is NOT reachable from the scheduled() path either", () => {
  // A cron is an unauthenticated caller in every sense that matters: nobody is behind it,
  // nothing checked a JWT, and it fires whether or not anyone is watching. So the daily run
  // sits behind the same wall email() does — it reads the DO and writes R2, and the
  // send-to-anyone capability is not in its import graph.
  const graph = reachable("scheduled.js");
  for (const f of ["compose.js", "send.js"])
    assert.equal(graph.has(f), false,
      `scheduled.js can reach ${f} via ${[...graph].join(", ")} — a cron can now send mail`);
});

test("scheduled() hands off to scheduled.js and names nothing else", () => {
  const s = code("index.js");
  const body = s.slice(s.indexOf("async scheduled(event, env, ctx)"), s.indexOf("export async function route"));
  assert.match(body, /runScheduled\(env, stub, event\?\.scheduledTime \|\| Date\.now\(\)\)/);
  assert.equal(/replyToMessage|composeNew|sendRaw|env\.SEND/.test(body), false,
    "scheduled() must not name the send path at all");
  assert.match(body, /try \{/, "a throw out of scheduled() is a failed run with nobody to tell");
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
    ['seg.length === 3 && request.method === "GET"', "stub.mailbox("],
    ['seg[3] === "messages" && request.method === "GET"', "stub.messages("],
    ['seg[3] === "send" && request.method === "POST"', "composeNew(env, stub, address"],
  ]) assert.match(between(s, route, act), /mayView\(stub, identity, owners, address\)/,
    `${act} is reachable without the view check`);
});

test("deleting mail is owner-only, and there is exactly one thing that deletes it", () => {
  // SubEtha had no delete at all until retention; the promise that replaced "nothing is ever
  // deleted" is "one route deletes, an owner asks for it by name, and it says what it took".
  const s = code("index.js");
  assert.equal(count(s, "purgeOlderThan(env, stub"), 1, "exactly one call site to guard");
  assert.match(between(s, 'seg[3] === "purge" && request.method === "POST"', "purgeOlderThan(env, stub"),
    /canAdmin\(identity, owners\)/,
    "the purge route is reachable without the admin check — a member could destroy the history");
  // The period is one of a fixed set, not a number: "1" is a plausible slip for "365".
  assert.match(between(s, 'seg[3] === "purge" && request.method === "POST"', "purgeOlderThan(env, stub"),
    /purgeDays\(body\?\.older_than_days\)/);
  const doCode = code("mailbox-do.js");
  assert.equal(count(doCode, "DELETE FROM messages"), 1,
    "exactly one statement removes stored mail, and it is the purge's");
  assert.match(between(doCode, "purgeRows(address, ids)", "DELETE FROM messages"),
    /DELETE FROM fanout_log/,
    "the fan-out rows must go first — a fanout_log row whose message is gone is an orphan");
});

test("the health route answers any authenticated identity, and nothing else does the deriving", () => {
  const s = code("index.js");
  const auth = s.indexOf('if (!identity) return json({ error: "unauthorized" }, 401);');
  const route = s.indexOf('path === "/api/health"');
  assert.ok(route > auth, "the health route must sit below the auth gate like every other route");
  // Deliberately NOT owner-only: the counts leak nothing but counts, and a member watching a
  // quiet mailbox needs to tell "nothing arrived" from "nothing works".
  assert.match(between(s, 'path === "/api/health"', "stub.health()"), /^[^\n]*shapeHealth/,
    "the health route must answer on the same line it is matched on, with no permission branch");
  assert.equal(count(s, "stub.health()"), 1);
  assert.equal(count(s, "shapeHealth(await stub.health())"), 1,
    "ok/degraded is derived in one place, from the one read-only call");
});

test("the config export is owner-only and is the same document the snapshot writes", () => {
  const s = code("index.js");
  assert.match(between(s, 'path === "/api/export"', "stub.exportConfig()"), /canAdmin\(identity, owners\)/,
    "the export is every mailbox, every member address and every rule in one response");
  // One method, two callers: the file in the bucket and the file behind the route cannot drift.
  const callers = files.filter((f) => /stub\.exportConfig\(\)/.test(code(f)));
  assert.deepEqual(callers.sort(), ["index.js", "scheduled.js"]);
  assert.equal(/messages|text|html|attachments/.test(
    between(code("mailbox-do.js"), "exportConfig()", "purgePreview(address, cutoff)")), false,
    "an export carries configuration and no mail");
});

test("the schema migration is additive, PRAGMA-guarded, and inside blockConcurrencyWhile", () => {
  // The object is LIVE while this runs. An ALTER that throws is a constructor that fails on
  // every RPC afterwards, which on this path means mail arriving at a DO that cannot start.
  const s = code("mailbox-do.js");
  const block = between(s, "ctx.blockConcurrencyWhile(async () => {", "#rows(sql, ...args)");
  assert.equal(count(s, "ALTER TABLE"), 1, "one place adds columns, and it is the guarded one");
  assert.ok(block.includes("ALTER TABLE"), "the migration must run inside blockConcurrencyWhile");
  assert.match(block, /PRAGMA table_info\(\$\{table\}\)/);
  assert.match(block, /if \(!have\.has\(name\)\) this\.sql\.exec\(`ALTER TABLE \$\{table\} ADD COLUMN/,
    "every ALTER must be skipped when its column is already there");
  for (const destructive of ["DROP COLUMN", "DROP TABLE", "RENAME TO", "RENAME COLUMN"])
    assert.equal(s.includes(destructive), false, `${destructive} is not an additive migration`);
  // Every migrated column is in the CREATE too, so a new object and an old one converge.
  const create = between(block, "CREATE TABLE IF NOT EXISTS mailboxes", "const columns = (table)");
  const migration = block.slice(block.indexOf("const columns = (table)"));
  for (const col of ["list_id", "hidden", "muted_by", "retention_days"]) {
    assert.ok(create.includes(col), `${col} is missing from the CREATE — a new object would not have it`);
    assert.ok(migration.includes(col), `${col} is missing from the migration — an existing object would not gain it`);
  }
  // A retention column with a default would start deleting on deploy. It has none, and null
  // means keep forever.
  assert.match(migration, /\["retention_days", "retention_days INTEGER"\]/);
});

test("a send-mode fan-out copy is marked machine-generated, and a human's reply is not", () => {
  // The fan-out is a machine re-sending somebody else's mail: a vacation autoresponder on the
  // far side must not answer it, and if the copy ever comes back through Email Routing the
  // loop guard stops it on this header alone.
  const s = code("inbound.js");
  assert.match(s, /"Auto-Submitted": "auto-replied"/);
  assert.match(between(s, "buildMime({", "X-Subetha-Original-From"), /"Auto-Submitted": "auto-replied"/,
    "the mark belongs on the built copy, beside the hop header");
  assert.equal(/Auto-Submitted/i.test(code("compose.js")), false,
    "a reply and a compose are written by a person — marking them auto-replied tells the recipient's mail system to ignore a human");
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
