# Backlog

## Current cycle — first deployment
- [x] Bucket, secret, deploy, Access application, AUD set, redeploy. Both hostnames verified: **401** before the Access app, **302 to the team login** after.
- [ ] Configure the first mailbox in the UI with the owner as its only member; **then** repoint that address's Email Routing rule at the worker (routing last — a rule pointed at an undeployed or broken worker bounces mail).
- [ ] Send a real mail to it; confirm the stored copy, the forward, and a reply from the UI. Only then add further members.
- [ ] Publish decision: flip the GitHub repo public once the README reads right; keep Issues/PRs enabled.
- [ ] Operators embedding this in a private infrastructure repo: keep your real `wrangler` config **outside** the copy/subtree so upstream merges never conflict on vars.

## Bugs
_(none known)_

## Next
- [ ] Loop guards — adopt `mailflare`'s superset: `X-Auto-Response-Suppress`, `X-Autoreply`, and skip senders whose local part is `mailer-daemon` / `postmaster` / `no-reply`; stamp send-mode fan-out with `Auto-Submitted: auto-replied` so other systems recognise it (UI replies stay unmarked — they are human).
- [ ] Classify forward errors as recoverable vs unrecoverable (per `artlessconstruct`) so the UI can say "retry" vs "fix the address".
- [ ] Runtime smoke test of the inbound path under `wrangler dev` (structural tests only, today).
- [ ] **Attachments on reply/compose**: `multipart/mixed` with base64 parts in `build-mime.js`, a file input on the reply and compose forms, size cap per Email Sending's message limit (check the docs before setting it). No schema or binding change — outbound is archived raw already. Interim: reply from the forwarded copy in a normal client.
- [ ] Watch the first week of a new mailbox's traffic: automated registration/confirmation mail often carries `Auto-Submitted` or `Precedence: bulk` and is stored-but-not-forwarded by design; if that turns out to be most of the traffic, narrow the guard to replies to our own outbound.
- [ ] `ROUTED_DOMAINS` is a manual list; it must be updated the day a new zone's routing points at the worker. Consider deriving it from the zones whose rules target this worker.

## Roadmap (explicitly parked — this is not a mail client)
- Additional zones (each needs Email Sending onboarding to send *from* it).
- Attachments rendered in the UI (they are archived in R2 today; "download raw" gets them).
- Sending-quota awareness: send-mode fan-out draws on the account's daily sending cap shared with everything else that sends; a per-mailbox cap or an alert.
- Not planned: HTML compose, read state, search, threading view, reply-to-list, live updates.
