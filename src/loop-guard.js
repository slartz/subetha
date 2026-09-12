// The loop guards. Pure — node-testable — because getting one of them wrong does not
// produce a bug report, it produces a mail loop between this worker and somebody else's
// autoresponder, at machine speed, burning the account's sending quota and the domain's
// sending reputation with it.
//
// Two independent guards:
//
//   MESSAGE-LEVEL (loopReason) — was this message itself AUTO-REPLIED? A vacation
//   autoresponder, a bounce, a mailing-list post. Fanning one of those out to five members
//   invites five more autoresponses. RFC 3834's Auto-Submitted is the modern mark, Precedence
//   the old one, X-Autoreply and X-Autorespond are what the autoresponders that predate the RFC
//   stamp on their own output, and X-Subetha-Hop is our own: a message this worker sent that
//   somehow arrives back here is stopped dead by it rather than going round again.
//
//   WHAT IS NOT A GUARD, and why. The question this predicate answers is "would forwarding
//   this go round again", NOT "is this machine-generated". A shared address exists precisely
//   to receive no-reply registration mail, notifications and receipts, and forwarding one of
//   those to a human member cannot loop — a person is not an autoresponder. So a
//   "do not auto-reply to me" marker is not a "do not forward me" marker:
//   X-Auto-Response-Suppress is deliberately NOT read, and neither is the sender's local part
//   (mailer-daemon, no-reply, bounces and the rest). Both were tried and removed. An
//   autoresponder that marks itself with neither Auto-Submitted nor X-Autoreply gets through,
//   and that is the accepted trade: the alternative silently swallowed the mail a shared
//   mailbox is for.
//
//   MEMBER-LEVEL (memberSkip) — would delivering to THIS member come straight back? The
//   mailbox itself obviously would. So would any address on a domain this worker routes,
//   because Email Routing would hand it back to email() — and Cloudflare short-circuits
//   mail addressed to a domain it routes, so the round trip is sub-second rather than a
//   normal internet hop. ROUTED_DOMAINS is the list of domains the worker itself routes.

import { domainOf } from "./build-mime.js";

export const LOOP_PRECEDENCE = new Set(["bulk", "junk", "list"]);

// The two pre-RFC spellings an autoresponder puts on ITS OWN OUTPUT, which is what makes them
// guards: a message carrying one is already an automatic reply, and replying to it — which a
// fan-out effectively does, five times — is how the loop starts. ANY value counts, unlike
// Auto-Submitted: neither has a value meaning "actually, a person wrote this", so there is no
// equivalent of "no" to honour. A header present with an EMPTY value reads as absent, exactly
// as X-Subetha-Hop does — nothing sends one, and treating a blank as a mark would make an
// accident of formatting into a suppressed fan-out.
//
// X-Auto-Response-Suppress is NOT in this list. It says "do not auto-reply to me", which is a
// different sentence: Exchange puts it on ordinary notification mail that a shared mailbox is
// meant to receive and hand on to people. See the banner.
export const AUTO_HEADERS = ["x-autoreply", "x-autorespond"];

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
  for (const name of AUTO_HEADERS) if (get(headers, name)) return name;
  const prec = get(headers, "precedence").toLowerCase();
  if (LOOP_PRECEDENCE.has(prec)) return `precedence:${prec}`;
  // Three deliberate omissions, all the same shape of decision. A List-Id means a mailing list
  // already fanned this out once — but legitimate shared mailboxes do subscribe to lists, so it
  // is stored on the row for the UI and for a mute rule instead. X-Auto-Response-Suppress and a
  // machine-looking From local part say "do not auto-reply to me", which is not "do not forward
  // me". Left here so the next reader knows all three were decisions.
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
