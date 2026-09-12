// Mute rules: the one thing a shared mailbox needs that a member list cannot express — "stop
// forwarding this to five people, but keep it". Pure — node-testable — because a rule decides
// whether mail is delivered at all, and a predicate that is only exercised through a route is
// a predicate nobody tests.
//
// v1 is MUTE ONLY. A muted message is still archived to R2, still stored, still readable in
// the UI behind "show muted"; what stops is the fan-out. Nothing here deletes anything.
//
// NO REGULAR EXPRESSIONS, deliberately. A pattern is typed by a person into a small box, it
// runs inside the Durable Object on the inbound path, and a regex is where a typo becomes
// either a rule that silently matches everything or one that takes exponential time on a
// subject a stranger chose. Four fields, two comparisons: equals, and contains.
import { validAddr, addrOf, domainOf } from "./build-mime.js";

export const FIELDS = new Set(["from", "from_domain", "subject", "list_id"]);
export const PATTERN_MAX = 200;

const lower = (v) => String(v ?? "").toLowerCase();

// Control characters go: a pattern is compared against a header value that has already had
// them stripped, so one here could only ever be a pattern that cannot match.
export const normalisePattern = (v) =>
  String(v ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim().toLowerCase().slice(0, PATTERN_MAX);

/**
 * What the owner typed, in the shape the rest of this module compares. The UI offers "domain
 * @example.com" and a pasted sender is often "Alice <alice@example.com>", so both are accepted
 * and reduced to the bare thing they mean.
 */
export function normaliseRule(field, pattern) {
  const f = lower(field).trim();
  let p = normalisePattern(pattern);
  if (f === "from") p = addrOf(p) || p;
  if (f === "from_domain") p = p.replace(/^@+/, "");
  return { field: f, pattern: p };
}

/**
 * The reason this rule cannot be saved, or null. An address or a domain that could never match
 * anything is refused at the door rather than stored as a rule that quietly does nothing —
 * "from: alice" (no domain) is the mistake this catches.
 */
export function ruleError({ field, pattern } = {}) {
  if (!FIELDS.has(field)) return `unknown rule field: ${String(field).slice(0, 40)}`;
  if (!pattern) return "a rule needs a pattern";
  if (pattern.length > PATTERN_MAX) return `pattern is longer than ${PATTERN_MAX} characters`;
  if (field === "from" && !validAddr(pattern)) return `not an address: ${pattern.slice(0, 120)}`;
  // A domain is valid exactly when an address at it would be — one validator, not two.
  if (field === "from_domain" && !validAddr(`x@${pattern}`)) return `not a domain: ${pattern.slice(0, 120)}`;
  return null;
}

/**
 * Does this rule match this message? `msg` is the stored row's shape: from_addr, subject,
 * list_id. Everything is lowercased on both sides.
 *
 * `from_domain` is an EXACT domain match: a rule for example.com does NOT match
 * mail.example.com. Subdomain matching is a v2 question — the loose version of it ("ends
 * with") makes a rule for example.com also mute notexample.com, and the tight version needs a
 * label-boundary comparison nobody would predict from reading the rule in the UI.
 */
export function matchRule(rule, msg) {
  const p = lower(rule?.pattern);
  if (!p) return false;
  switch (rule?.field) {
    case "from": return lower(msg?.from_addr) === p;
    case "from_domain": return domainOf(lower(msg?.from_addr)) === p;
    case "subject": return lower(msg?.subject).includes(p);
    case "list_id": return lower(msg?.list_id).includes(p);
    default: return false;
  }
}

// The first match in the order given — the DO asks by id, so the OLDEST rule wins. One match,
// one attribution: a message is muted BY a rule, and `hits` has to add up.
export function firstMatch(rules, msg) {
  for (const r of rules || []) if (matchRule(r, msg)) return r;
  return null;
}

// LIKE's two wildcards, escaped so a pattern containing one matches it literally. Backslash
// first, or the escapes this adds would themselves be escaped.
export const likeEscape = (s) =>
  String(s ?? "").replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");

/**
 * The same predicate as SQL, for the retroactive pass when a rule is created: one UPDATE over
 * the stored rows rather than a read-modify-write of each. `{sql, arg}` — the fragment goes
 * into a WHERE clause and the arg is BOUND, never interpolated.
 *
 * Note the deliberate asymmetry with matchRule(): SQLite's lower() folds ASCII only, so a
 * retroactive subject match is case-insensitive for ASCII and case-SENSITIVE for anything
 * else, while live matching in JS folds the lot. It costs an odd result on a Cyrillic subject
 * typed in the wrong case; the alternative is reading every stored row into the isolate.
 */
export function sqlPredicate({ field, pattern } = {}) {
  const p = lower(pattern);
  if (!p || !FIELDS.has(field)) return null;
  switch (field) {
    case "from":
      return { sql: "lower(from_addr) = ?", arg: p };
    // instr() is guarded: without it an address with no @ at all would have its whole value
    // compared against the domain, and "example.com" as a from_addr would match.
    case "from_domain":
      return { sql: "instr(from_addr, '@') > 0 AND lower(substr(from_addr, instr(from_addr, '@') + 1)) = ?", arg: p };
    case "subject":
      return { sql: "lower(subject) LIKE ? ESCAPE '\\'", arg: `%${likeEscape(p)}%` };
    case "list_id":
      return { sql: "lower(list_id) LIKE ? ESCAPE '\\'", arg: `%${likeEscape(p)}%` };
    default:
      return null;
  }
}
