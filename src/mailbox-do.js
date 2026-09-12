// MailboxDO — all of SubEtha's state, in one SQLite-backed Durable Object reached by
// idFromName("subetha"). One instance: a shared mailbox is a handful of messages a day, and
// a single object makes "list every mailbox" one query instead of a fan-in.
//
// The object does state and NOTHING ELSE. It never sends, never forwards, never waits on
// the network — a DO call that blocks on Cloudflare Email Sending holds the object's single
// thread, and every other mailbox's inbound message queues behind it. So the inbound path
// is exactly two hops: inbound() inserts the row and hands back the member list, the worker
// does the forwards and sends outside the object, and recordFanout() writes what happened.
//
// RPC surface only — no fetch() handler on the object; callers invoke its methods directly.
import { DurableObject } from "cloudflare:workers";
import { withMemberStatus } from "./fanout-status.js";

const now = () => Date.now();

export class MailboxDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Idempotent, and inside blockConcurrencyWhile so no RPC can reach a half-built schema.
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS mailboxes (
        address TEXT PRIMARY KEY, display_name TEXT, created_at INTEGER)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS members (
        mailbox TEXT, email TEXT, mode TEXT CHECK(mode IN ('forward','send')),
        added_at INTEGER, PRIMARY KEY (mailbox, email))`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mailbox TEXT, message_id TEXT, in_reply_to TEXT, references_hdr TEXT,
        direction TEXT CHECK(direction IN ('in','out')),
        from_addr TEXT, from_name TEXT, reply_to TEXT, to_addrs TEXT, cc_addrs TEXT,
        subject TEXT, date_hdr TEXT, received_at INTEGER,
        text TEXT, html TEXT, r2_key TEXT, size INTEGER, attachments_json TEXT,
        unconfigured INTEGER DEFAULT 0, sent_by TEXT)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS messages_box ON messages(mailbox, id)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS fanout_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_row INTEGER, member TEXT, mode TEXT, ok INTEGER, error TEXT, at INTEGER)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS fanout_row ON fanout_log(message_row)`);
    });
  }

  #rows(sql, ...args) { return this.sql.exec(sql, ...args).toArray(); }
  #lastId() { return Number(this.sql.exec("SELECT last_insert_rowid() AS id").one().id); }

  // ---------- configuration ----------

  config(address) {
    const box = this.#rows("SELECT * FROM mailboxes WHERE address=?", address)[0] || null;
    if (!box) return null;
    return { ...box, members: this.#rows("SELECT email, mode FROM members WHERE mailbox=? ORDER BY email", address) };
  }

  // Configured mailboxes UNION addresses that have only ever received mail. An address the
  // routing rule points here but nobody has configured has no mailboxes row at all, so
  // listing the table alone would hide exactly the thing the operator needs to see.
  mailboxes() {
    return this.#rows(`
      SELECT a.address AS address,
             m.display_name AS display_name,
             m.created_at AS created_at,
             (m.address IS NOT NULL) AS configured,
             (SELECT COUNT(*) FROM members WHERE mailbox = a.address) AS member_count,
             (SELECT COUNT(*) FROM messages WHERE mailbox = a.address) AS message_count,
             (SELECT COUNT(*) FROM messages WHERE mailbox = a.address AND unconfigured = 1) AS unconfigured_count
      FROM (SELECT address FROM mailboxes UNION SELECT mailbox AS address FROM messages) a
      LEFT JOIN mailboxes m ON m.address = a.address
      ORDER BY a.address`)
      // The editor needs the member list, not just its size, and a shared mailbox has a
      // handful of them — cheaper than a second round trip per mailbox from the browser.
      // Same for each member's last delivery: a forward to an address that is not a verified
      // destination fails on every message, quietly, and the member row is where that belongs.
      .map((r) => withMemberStatus({
        ...r,
        members: this.#rows("SELECT email, mode FROM members WHERE mailbox=? ORDER BY email", r.address),
        member_status: this.memberStatus(r.address),
      }));
  }

  // The latest fan-out attempt per member of this mailbox. Read-only, and no new table: the
  // rows are already in fanout_log, and "what happened to this member last time" is the one
  // thing a member row cannot say without asking.
  //
  // Scoped through messages, because fanout_log has no mailbox column of its own: without the
  // join a member who is on two mailboxes would be shown the other mailbox's result on both.
  // Latest is by id, not by `at` — one recordFanout() call stamps every row in the batch with
  // the same millisecond. A member with no attempt yet comes back with the columns NULL.
  memberStatus(mailbox) {
    return this.#rows(`
      SELECT mb.email AS email, f.mode AS mode, f.ok AS ok, f.error AS error,
             f.at AS at, f.message_row AS message_row
      FROM members mb
      LEFT JOIN fanout_log f ON f.id = (
        SELECT f2.id FROM fanout_log f2
        JOIN messages ms ON ms.id = f2.message_row
        WHERE f2.member = mb.email AND ms.mailbox = mb.mailbox
        ORDER BY f2.id DESC LIMIT 1)
      WHERE mb.mailbox = ?
      ORDER BY mb.email`, mailbox);
  }

  // Members are REPLACED, not merged: the editor posts the whole list, so a row missing
  // from it is a removal. Merging would make removing a member impossible from the UI.
  upsertMailbox(address, display_name, members) {
    this.sql.exec(
      `INSERT INTO mailboxes(address, display_name, created_at) VALUES(?,?,?)
       ON CONFLICT(address) DO UPDATE SET display_name=excluded.display_name`,
      address, display_name ?? null, now());
    this.sql.exec("DELETE FROM members WHERE mailbox=?", address);
    for (const m of members || [])
      this.sql.exec("INSERT OR REPLACE INTO members(mailbox,email,mode,added_at) VALUES(?,?,?,?)",
        address, m.email, m.mode, now());
    // The same shape the list returns, status and all: the editor redraws its rows from this
    // response, and a member whose last delivery failed must not lose that on a save. config()
    // itself stays lean — mayView() and compose.js ask it on every read and neither needs it.
    return withMemberStatus({ ...this.config(address), member_status: this.memberStatus(address) });
  }

  // Messages are KEPT. They are the mailbox's history and deleting the configuration is an
  // administrative act, not a decision to destroy mail; the rows stay queryable by address
  // and the archive in R2 is untouched either way.
  deleteMailbox(address) {
    this.sql.exec("DELETE FROM members WHERE mailbox=?", address);
    const r = this.sql.exec("DELETE FROM mailboxes WHERE address=?", address);
    return { deleted: address, removed: r.rowsWritten, messages_kept: true };
  }

  // ---------- inbound: ONE hop ----------

  /**
   * Insert the arriving message and hand back everything the worker needs to fan it out.
   * The worker then does the forwards/sends outside this object and calls recordFanout().
   */
  inbound(row) {
    const cfg = this.config(row.mailbox);
    this.sql.exec(
      `INSERT INTO messages(mailbox,message_id,in_reply_to,references_hdr,direction,from_addr,from_name,
        reply_to,to_addrs,cc_addrs,subject,date_hdr,received_at,text,html,r2_key,size,attachments_json,
        unconfigured,sent_by)
       VALUES(?,?,?,?,'in',?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
      row.mailbox, row.message_id ?? null, row.in_reply_to ?? null, row.references_hdr ?? null,
      row.from_addr ?? null, row.from_name ?? null, row.reply_to ?? null, row.to_addrs ?? null,
      row.cc_addrs ?? null, row.subject ?? null, row.date_hdr ?? null, row.received_at ?? now(),
      row.text ?? null, row.html ?? null, row.r2_key ?? null, row.size ?? null,
      row.attachments_json ?? "[]", cfg ? 0 : 1);
    return {
      id: this.#lastId(),
      configured: !!cfg,
      display_name: cfg?.display_name ?? null,
      members: cfg?.members ?? [],
    };
  }

  /** results: [{member, mode, ok, error}] — the second and last hop of the inbound path. */
  recordFanout(messageRow, results) {
    const at = now();
    for (const r of results || [])
      this.sql.exec("INSERT INTO fanout_log(message_row,member,mode,ok,error,at) VALUES(?,?,?,?,?,?)",
        messageRow, r.member ?? null, r.mode ?? null, r.ok ? 1 : 0,
        r.error ? String(r.error).slice(0, 400) : null, at);
    return { recorded: (results || []).length };
  }

  // ---------- outbound ----------

  storeOutbound(row) {
    this.sql.exec(
      `INSERT INTO messages(mailbox,message_id,in_reply_to,references_hdr,direction,from_addr,from_name,
        reply_to,to_addrs,cc_addrs,subject,date_hdr,received_at,text,html,r2_key,size,attachments_json,
        unconfigured,sent_by)
       VALUES(?,?,?,?,'out',?,?,NULL,?,?,?,?,?,?,NULL,?,?,'[]',0,?)`,
      row.mailbox, row.message_id ?? null, row.in_reply_to ?? null, row.references_hdr ?? null,
      row.from_addr ?? null, row.from_name ?? null, row.to_addrs ?? null, row.cc_addrs ?? null,
      row.subject ?? null, row.date_hdr ?? null, row.received_at ?? now(), row.text ?? null,
      row.r2_key ?? null, row.size ?? null, row.sent_by ?? null);
    const id = this.#lastId();
    if (row.fanout?.length) this.recordFanout(id, row.fanout);
    return this.message(id);
  }

  // ---------- reading ----------

  /** Newest first, no bodies. `before` pages backwards by id. */
  messages(address, before, limit) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const b = Number(before) || 0;
    const rows = this.#rows(`
      SELECT m.id, m.direction, m.from_addr, m.from_name, m.subject, m.date_hdr, m.received_at,
             m.size, m.unconfigured, m.sent_by, m.to_addrs, m.attachments_json,
             (SELECT COUNT(*) FROM fanout_log f WHERE f.message_row = m.id) AS fanout_total,
             (SELECT COUNT(*) FROM fanout_log f WHERE f.message_row = m.id AND f.ok = 1) AS fanout_ok
      FROM messages m
      WHERE m.mailbox = ? ${b ? "AND m.id < ?" : ""}
      ORDER BY m.id DESC LIMIT ?`, ...(b ? [address, b, n] : [address, n]));
    return rows.map(({ attachments_json, ...r }) => ({
      ...r,
      has_attachments: (() => { try { return (JSON.parse(attachments_json || "[]") || []).length > 0; } catch { return false; } })(),
    }));
  }

  message(id) {
    const row = this.#rows("SELECT * FROM messages WHERE id=?", Number(id) || 0)[0];
    if (!row) return null;
    return { ...row, fanout: this.#rows("SELECT member, mode, ok, error, at FROM fanout_log WHERE message_row=? ORDER BY id", row.id) };
  }
}
