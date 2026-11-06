// Copies new records from the database into the local history file.
import { redactHeaders, redactUrl } from "./format.js";

const BODY_LIMIT = 20000; // characters of a reply we keep

/** Splits a trigger's stored arguments into url / method / headers / params. */
export function parseTriggerArgs(buf) {
  if (!buf) return null;
  const text = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
  const parts = text.split("\0");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  const json = (s) => {
    try {
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  };
  return {
    url: parts[0] || null,
    method: parts[1] || null,
    headers: json(parts[2]),
    params: json(parts[3]),
    timeout: parts[4] ? Number(parts[4]) : null,
  };
}

const iso = (d) => (d instanceof Date ? d.toISOString() : d ? String(d) : null);

/** Checks one optional table. Missing is fine; "no permission" is reported. */
async function probe(conn, name) {
  try {
    const r = await conn.query("select to_regclass($1) is not null as present", [name]);
    return { present: r.rows[0].present, blocked: null };
  } catch (e) {
    if (e?.code === "42501") {
      return { present: false, blocked: String(e.message).split("\n")[0] };
    }
    throw e;
  }
}

/** Checks which optional parts exist in this database. */
export async function detect(conn) {
  const hooks = await probe(conn, "supabase_functions.hooks");
  const capture = await probe(conn, "pgnet_lens.requests");
  return {
    hooks: hooks.present,
    capture: capture.present,
    hooksBlocked: hooks.blocked,
    captureBlocked: capture.blocked,
  };
}

const OVERLAP_MS = 60_000;
const back = (isoTime) => new Date(new Date(isoTime).getTime() - OVERLAP_MS).toISOString();

/**
 * One round of copying. Returns what was new.
 * state is remembered between rounds. Each table has its own "start from"
 * time, so a slow request is never skipped because a newer reply arrived.
 */
export async function syncOnce(conn, store, state, opts = {}) {
  const noBodies = Boolean(opts.noBodies);
  const found = await detect(conn);
  const added = { responses: [], hooks: 0, requests: 0 };
  let newestResp = null;
  let newestHook = null;
  let newestReq = null;

  // 1) Replies from pg_net.
  const resp = await conn.query(
    `select id::text as id, status_code, content_type, headers,
            ${noBodies ? "null::text" : `left(content, ${BODY_LIMIT})`} as content,
            length(content) as content_length,
            timed_out, error_msg, created
       from net._http_response
      where ($1::timestamptz is null or created >= $1::timestamptz)
      order by created, id`,
    [state.sinceResp ?? null]
  );
  for (const row of resp.rows) {
    const created = iso(row.created);
    if (!newestResp || created > newestResp) newestResp = created;
    const rec = {
      key: `r|${row.id}|${created}`,
      t: "response",
      id: row.id,
      created,
      status: row.status_code,
      timedOut: Boolean(row.timed_out),
      error: row.error_msg,
      contentType: row.content_type,
      headers: redactHeaders(row.headers),
      body: row.content,
      bodyTruncated: row.content != null && row.content_length > BODY_LIMIT,
    };
    if (store.add(rec)) added.responses.push(row.id);
  }

  // 2) Webhook list (only exists once Database Webhooks were used).
  if (found.hooks) {
    const hooks = await conn.query(
      `select h.request_id::text as request_id, h.hook_name, h.created_at,
              n.nspname || '.' || c.relname as table_name,
              t.tgargs
         from supabase_functions.hooks h
         left join pg_class c on c.oid = h.hook_table_id::bigint::oid
         left join pg_namespace n on n.oid = c.relnamespace
         left join pg_trigger t
                on t.tgrelid = c.oid and t.tgname = h.hook_name and not t.tgisinternal
        where h.request_id is not null
          and ($1::timestamptz is null or h.created_at >= $1::timestamptz)
        order by h.request_id`,
      [state.sinceHooks ?? null]
    );
    for (const row of hooks.rows) {
      const hookTime = iso(row.created_at);
      if (hookTime && (!newestHook || hookTime > newestHook)) newestHook = hookTime;
      const args = parseTriggerArgs(row.tgargs);
      const rec = {
        key: `h|${row.request_id}`,
        t: "hook",
        requestId: row.request_id,
        createdAt: iso(row.created_at),
        hookName: row.hook_name,
        table: row.table_name,
        url: redactUrl(args?.url ?? null),
        method: args?.method ?? null,
        headers: redactHeaders(args?.headers ?? null),
        params: args?.params ?? null,
      };
      if (store.add(rec)) added.hooks++;
    }
  }

  // 3) Requests remembered by the optional setup.
  if (found.capture) {
    const reqs = await conn.query(
      `select request_id::text as request_id, created_at, method, url, params,
              headers, ${noBodies ? "null::jsonb" : "body"} as body
         from pgnet_lens.requests
        where ($1::timestamptz is null or created_at >= $1::timestamptz)
        order by request_id`,
      [state.sinceReq ?? null]
    );
    for (const row of reqs.rows) {
      const reqTime = iso(row.created_at);
      if (reqTime && (!newestReq || reqTime > newestReq)) newestReq = reqTime;
      const rec = {
        key: `q|${row.request_id}`,
        t: "request",
        requestId: row.request_id,
        createdAt: iso(row.created_at),
        method: row.method,
        url: redactUrl(row.url),
        params: row.params,
        headers: redactHeaders(row.headers),
        body: row.body,
      };
      if (store.add(rec)) added.requests++;
    }
  }

  // Next round starts one minute before the newest record of each kind, so
  // late arrivals are not missed. Duplicates are ignored by key.
  if (newestResp) state.sinceResp = back(newestResp);
  if (newestHook) state.sinceHooks = back(newestHook);
  if (newestReq) state.sinceReq = back(newestReq);
  return { added, found };
}