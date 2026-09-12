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
import { firstMatch, sqlPredicate } from "./rules.js";

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
        unconfigured INTEGER DEFAULT 0, sent_by TEXT,
        list_id TEXT, hidden INTEGER NOT NULL DEFAULT 0, muted_by INTEGER)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS messages_box ON messages(mailbox, id)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS fanout_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_row INTEGER, member TEXT, mode TEXT, ok INTEGER, error TEXT, at INTEGER)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS fanout_row ON fanout_log(message_row)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mailbox TEXT NOT NULL,
        field TEXT NOT NULL CHECK(field IN ('from','from_domain','subject','list_id')),
        pattern TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT 'mute' CHECK(action IN ('mute')),
        created_by TEXT, created_at INTEGER, hits INTEGER NOT NULL DEFAULT 0)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS rules_box ON rules(mailbox)`);

      // MIGRATION. The three columns above are in the CREATE for a new object; an object that
      // already holds mail was created without them, and this brings it to the same shape.
      // Additive only, and guarded by PRAGMA rather than by a version number — ADD COLUMN on a
      // column that exists throws, and a throw in here is a constructor that fails on every
      // RPC afterwards, which on this path means mail arriving at a Durable Object that cannot
      // start. There is no migration window: the object is live the whole time.
      const have = new Set(this.sql.exec("PRAGMA table_info(messages)").toArray().map((c) => c.name));
      for (const [name, ddl] of [
        ["list_id", "list_id TEXT"],
        ["hidden", "hidden INTEGER NOT NULL DEFAULT 0"],
        ["muted_by", "muted_by INTEGER"],
      ]) if (!have.has(name)) this.sql.exec(`ALTER TABLE messages ADD COLUMN ${ddl}`);
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

  // Configured mailboxes UNION addresses that have only ever received mail UNION addresses
  // that only have a rule. An address the routing rule points here but nobody has configured
  // has no mailboxes row at all, so listing the table alone would hide exactly the thing the
  // operator needs to see — and a mailbox muted before it was configured is the same case.
  mailboxes() {
    return this.#rows(`
      SELECT a.address AS address,
             m.display_name AS display_name,
             m.created_at AS created_at,
             (m.address IS NOT NULL) AS configured,
             (SELECT COUNT(*) FROM members WHERE mailbox = a.address) AS member_count,
             (SELECT COUNT(*) FROM messages WHERE mailbox = a.address) AS message_count,
             (SELECT COUNT(*) FROM messages WHERE mailbox = a.address AND unconfigured = 1) AS unconfigured_count,
             (SELECT COUNT(*) FROM rules WHERE mailbox = a.address) AS rule_count,
             (SELECT COUNT(*) FROM messages WHERE mailbox = a.address AND hidden = 1) AS muted_count
      FROM (SELECT address FROM mailboxes
            UNION SELECT mailbox AS address FROM messages
            UNION SELECT mailbox AS address FROM rules) a
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

  // ---------- rules ----------

  /** Every rule on this mailbox, oldest first — which is also the order they are matched in. */
  rules(mailbox) {
    return this.#rows("SELECT * FROM rules WHERE mailbox=? ORDER BY id", mailbox);
  }

  // Create the rule, then apply it BACKWARDS over what is already stored: a rule added after
  // the fact is almost always a rule that was wanted before it, and the newsletter the owner
  // is muting is sitting in the list as they type. One UPDATE in SQL rather than a
  // read-modify-write per row — the object's thread is shared with every mailbox's inbound.
  //
  // Rows already hidden are left alone, so the rule that muted them first keeps the hit and
  // the attribution; `hits` therefore counts messages muted BY THIS RULE and nothing else.
  addRule(mailbox, field, pattern, created_by) {
    const p = sqlPredicate({ field, pattern });
    if (!p) throw new Error(`unknown rule field: ${String(field).slice(0, 40)}`);
    this.sql.exec(
      "INSERT INTO rules(mailbox,field,pattern,action,created_by,created_at,hits) VALUES(?,?,?,'mute',?,?,0)",
      mailbox, field, pattern, created_by ?? null, now());
    const id = this.#lastId();
    const r = this.sql.exec(
      `UPDATE messages SET hidden=1, muted_by=?
       WHERE mailbox=? AND direction='in' AND hidden=0 AND ${p.sql}`,
      id, mailbox, p.arg);
    const hidden_now = r.rowsWritten;
    if (hidden_now) this.sql.exec("UPDATE rules SET hits = hits + ? WHERE id=?", hidden_now, id);
    return { rule: this.#rows("SELECT * FROM rules WHERE id=?", id)[0] ?? null, hidden_now };
  }

  // The rule goes; the messages it hid STAY hidden. Un-hiding them would be a second bulk
  // action — the opposite one — hiding inside a delete, and an owner who removes a rule means
  // "stop muting from now on" far more often than "resurface three months of newsletters".
  // Un-hiding is per message, deliberate, and owner-only.
  deleteRule(mailbox, id) {
    const n = Number(id) || 0;
    const r = this.sql.exec("DELETE FROM rules WHERE id=? AND mailbox=?", n, mailbox);
    return { deleted: n, removed: r.rowsWritten, messages_kept_hidden: true };
  }

  // Manual override for one message. Un-hiding CLEARS muted_by: the row is no longer muted by
  // that rule, and leaving the id on it would have the UI explaining a mute that is not in
  // force. The rule itself is untouched, so the next message matching it is muted again.
  setHidden(id, hidden) {
    const h = hidden ? 1 : 0;
    const n = Number(id) || 0;
    this.sql.exec(`UPDATE messages SET hidden=?, muted_by=${h ? "muted_by" : "NULL"} WHERE id=?`, h, n);
    return this.#rows("SELECT id, hidden, muted_by FROM messages WHERE id=?", n)[0] ?? null;
  }

  // Messages are KEPT. They are the mailbox's history and deleting the configuration is an
  // administrative act, not a decision to destroy mail; the rows stay queryable by address
  // and the archive in R2 is untouched either way. Rules are kept for the same reason and with
  // the same consequence: mail to the address is still stored, still muted where a rule says
  // so, and the address stays in the mailbox list carrying its rule count.
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
    // Rules are evaluated HERE, and only here. This is the one call that already knows the
    // mailbox, has the row in hand and is about to hand back the member list, so muting costs
    // no extra hop — the inbound path is still exactly two. A match stores the row hidden and
    // hands the worker NO members, which is what makes "muted" mean "nothing was forwarded"
    // rather than "the UI filters it afterwards".
    const rule = firstMatch(this.rules(row.mailbox), row);
    this.sql.exec(
      `INSERT INTO messages(mailbox,message_id,in_reply_to,references_hdr,direction,from_addr,from_name,
        reply_to,to_addrs,cc_addrs,subject,date_hdr,received_at,text,html,r2_key,size,attachments_json,
        unconfigured,sent_by,list_id,hidden,muted_by)
       VALUES(?,?,?,?,'in',?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`,
      row.mailbox, row.message_id ?? null, row.in_reply_to ?? null, row.references_hdr ?? null,
      row.from_addr ?? null, row.from_name ?? null, row.reply_to ?? null, row.to_addrs ?? null,
      row.cc_addrs ?? null, row.subject ?? null, row.date_hdr ?? null, row.received_at ?? now(),
      row.text ?? null, row.html ?? null, row.r2_key ?? null, row.size ?? null,
      row.attachments_json ?? "[]", cfg ? 0 : 1,
      row.list_id ?? null, rule ? 1 : 0, rule ? rule.id : null);
    const id = this.#lastId();
    if (rule) this.sql.exec("UPDATE rules SET hits = hits + 1 WHERE id=?", rule.id);
    return {
      id,
      configured: !!cfg,
      display_name: cfg?.display_name ?? null,
      members: rule ? [] : (cfg?.members ?? []),
      muted_by: rule ? { id: rule.id, field: rule.field, pattern: rule.pattern } : null,
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

  /**
   * Newest first, no bodies. `before` pages backwards by id.
   *
   * Muted messages are EXCLUDED unless asked for. A mute is "I do not want to see this", so
   * hiding it in the default list is the whole feature; the rows are never deleted and
   * includeHidden brings them straight back.
   */
  messages(address, before, limit, includeHidden) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const b = Number(before) || 0;
    const rows = this.#rows(`
      SELECT m.id, m.direction, m.from_addr, m.from_name, m.subject, m.date_hdr, m.received_at,
             m.size, m.unconfigured, m.sent_by, m.to_addrs, m.attachments_json, m.hidden, m.muted_by,
             (SELECT COUNT(*) FROM fanout_log f WHERE f.message_row = m.id) AS fanout_total,
             (SELECT COUNT(*) FROM fanout_log f WHERE f.message_row = m.id AND f.ok = 1) AS fanout_ok
      FROM messages m
      WHERE m.mailbox = ? ${includeHidden ? "" : "AND m.hidden = 0"} ${b ? "AND m.id < ?" : ""}
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
