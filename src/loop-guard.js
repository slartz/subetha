// The loop guards. Pure — node-testable — because getting one of them wrong does not
// produce a bug report, it produces a mail loop between this worker and somebody else's
// autoresponder, at machine speed, burning the account's sending quota and the domain's
// sending reputation with it.
//
// Two independent guards:
//
//   MESSAGE-LEVEL (loopReason) — is this message itself machine-generated? A vacation
//   autoresponder, a bounce, a mailing-list post. Fanning one of those out to five members
//   invites five more autoresponses. RFC 3834's Auto-Submitted is the modern mark,
//   Precedence the old one, and X-Subetha-Hop is our own: a message this worker sent that
//   somehow arrives back here is stopped dead by it rather than going round again.
//
//   MEMBER-LEVEL (memberSkip) — would delivering to THIS member come straight back? The
//   mailbox itself obviously would. So would any address on a domain this worker routes,
//   because Email Routing would hand it back to email() — and Cloudflare short-circuits
//   mail addressed to a domain it routes, so the round trip is sub-second rather than a
//   normal internet hop. ROUTED_DOMAINS is the list of domains the worker itself routes.

import { domainOf } from "./build-mime.js";

export const LOOP_PRECEDENCE = new Set(["bulk", "junk", "list"]);

// Works with a Headers object or anything else exposing get(name).
const get = (h, name) => {
  const v = typeof h?.get === "function" ? h.get(name) : h?.[name] ?? h?.[name.toLowerCase()];
  return v == null ? "" : String(v).trim();
};

/** Why this message must not be fanned out at all, or null when it may be. */
export function loopReason(headers) {
  const hop = get(headers, "x-subetha-hop");
  if (hop) return "x-subetha-hop";
  // RFC 3834: "no" is the one value that means "a person sent this".
  const auto = get(headers, "auto-submitted").toLowerCase().split(";")[0].trim();
  if (auto && auto !== "no") return `auto-submitted:${auto}`;
  const prec = get(headers, "precedence").toLowerCase();
  if (LOOP_PRECEDENCE.has(prec)) return `precedence:${prec}`;
  // A List-Id means a mailing list already fanned this out once. Not in the brief's list,
  // and therefore NOT a guard here — it is stored on the row so the UI can show it, and
  // legitimate shared mailboxes do subscribe to lists. Left as a comment so the next reader
  // knows the omission was a decision.
  return null;
}

export const parseDomains = (v) =>
  new Set(String(v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

/** Why this member must be skipped, or null when it may be delivered to. */
export function memberSkip(member, mailbox, routedDomains) {
  const m = String(member ?? "").trim().toLowerCase();
  const box = String(mailbox ?? "").trim().toLowerCase();
  if (!m) return "empty";
  if (m === box) return "self";
  const routed = routedDomains instanceof Set ? routedDomains : parseDomains(routedDomains);
  if (routed.has(domainOf(m))) return "routed-domain";
  return null;
}
