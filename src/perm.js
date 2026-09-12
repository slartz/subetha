// Who may see which mailbox, and who may change one. Pure — node-testable — because this is
// the only thing standing between a member of ONE mailbox and every other mailbox in the
// zone, and a predicate that is only exercised through a route is a predicate nobody tests.
//
// Two roles, and no third:
//
//   OWNER  — an address listed in the OWNERS var, or the ADMIN_SECRET bearer, which is
//            owner-equivalent because it is the operator's own automation credential and can
//            already reach every route. Sees every mailbox; may create, edit and delete them.
//   MEMBER — an address on some mailbox's member list, in either mode. Sees THAT mailbox:
//            reads it, downloads its raw mail, replies and composes from it. May not change
//            its configuration, and may not see a mailbox it is not on.
//
// Anyone who is neither gets 403 from every route that names a mailbox or a message. The
// shell at GET / still renders for them, with an empty list — a page that says "you are on
// no mailbox" is a better answer to a mistyped bookmark than a bare 403.
//
// Comparison is lowercase and otherwise literal. Gmail's dots and +tags are NOT normalised:
// two different strings are two different identities, and an address-equivalence rule that is
// right for one provider is wrong for the next.
export const parseOwners = (v) =>
  new Set(String(v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

const lower = (v) => String(v ?? "").trim().toLowerCase();

/** May this identity create, edit or delete a mailbox configuration? */
export function canAdmin(identity, owners) {
  // The bearer is the ADMIN_SECRET holder. It is not an email and must never be matched
  // against the owner list as one.
  if (identity === "bearer") return true;
  const id = lower(identity);
  if (!id) return false;
  return (owners instanceof Set ? owners : parseOwners(owners)).has(id);
}

/** Is this identity on this mailbox's member list, in either mode? */
export function isMember(identity, box) {
  const id = lower(identity);
  if (!id || id === "bearer") return false;
  return (box?.members || []).some((m) => lower(m?.email) === id);
}

/** May this identity read this mailbox and send from it? */
export const canView = (identity, owners, box) => canAdmin(identity, owners) || isMember(identity, box);

/** The mailboxes this identity is allowed to know exist. */
export const visibleMailboxes = (all, identity, owners) =>
  canAdmin(identity, owners) ? (all || []) : (all || []).filter((b) => isMember(identity, b));
