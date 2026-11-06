// `pgnet-lens doctor`: checks that everything we need is readable.
import { detect } from "./sync.js";

const ICON = { PASS: "✔", INFO: "i", WARN: "!", FAIL: "✘" };

const firstLine = (e) => String(e?.message ?? e).split("\n")[0];

export async function runDoctor(conn, target) {
  const results = [];
  const rec = (status, name, detail = "") => {
    results.push(status);
    console.log(`${ICON[status]} [${status}] ${name}${detail ? " - " + detail : ""}`);
  };

  console.log(`\nChecking ${target.host} / ${target.database}\n`);

  // 1. Connection
  try {
    const r = await conn.query(
      "select current_user as u, split_part(version(), ' ', 2) as v"
    );
    rec("PASS", "Connected to the database", `user ${r.rows[0].u}, Postgres ${r.rows[0].v}`);
  } catch (e) {
    rec("FAIL", "Connected to the database", firstLine(e));
    console.log(
      "\nHints:\n" +
        "- ENOTFOUND, ETIMEDOUT or IPv6 in the message: use the 'Session pooler' link\n" +
        "  (Connect button -> Direct tab -> Session pooler).\n" +
        "- 'password authentication failed': reset the database password to letters\n" +
        "  and numbers only and rebuild the link.\n"
    );
    return 1;
  }

  // 2. pg_net
  try {
    const r = await conn.query(
      "select extversion from pg_extension where extname = 'pg_net'"
    );
    if (r.rowCount === 0) {
      rec("FAIL", "pg_net is installed", "not found. Turn it on under Database -> Extensions");
    } else {
      rec("PASS", "pg_net is installed", `version ${r.rows[0].extversion}`);
    }
  } catch (e) {
    rec("FAIL", "pg_net is installed", firstLine(e));
  }

  // 3. Keep-for time
  try {
    const r = await conn.query("show pg_net.ttl");
    rec("INFO", "Supabase keeps replies for", r.rows[0]["pg_net.ttl"]);
  } catch (e) {
    rec("WARN", "Supabase keeps replies for", `could not read (${firstLine(e)})`);
  }

  // 4. Replies readable
  try {
    const r = await conn.query("select count(*)::int as n from net._http_response");
    rec("PASS", "Can read replies (net._http_response)", `${r.rows[0].n} right now`);
  } catch (e) {
    rec("FAIL", "Can read replies (net._http_response)", firstLine(e));
  }

  // 5. Webhook list and the optional setup
  let found = { hooks: false, capture: false };
  try {
    found = await detect(conn);
  } catch (e) {
    rec("WARN", "Look for optional parts", firstLine(e));
  }

  if (found.hooksBlocked) {
    rec(
      "WARN",
      "Webhook list (supabase_functions.hooks)",
      `this user is not allowed to look (${found.hooksBlocked}). ` +
        "Replies are still saved, but webhook names and table names will be missing"
    );
  } else if (!found.hooks) {
    rec(
      "INFO",
      "Webhook list (supabase_functions.hooks)",
      "not created yet. Normal until you create your first Database Webhook"
    );
  } else {
    try {
      const r = await conn.query("select count(*)::int as n from supabase_functions.hooks");
      rec("PASS", "Can read the webhook list", `${r.rows[0].n} entries right now`);
    } catch (e) {
      rec("FAIL", "Can read the webhook list", firstLine(e));
    }
    try {
      await conn.query("select count(*)::int as n from pg_trigger");
      rec("PASS", "Can read webhook addresses (pg_trigger)");
    } catch (e) {
      rec("WARN", "Can read webhook addresses (pg_trigger)", firstLine(e));
    }
  }

  if (found.captureBlocked) {
    rec("WARN", "Request memory (pgnet_lens)", `this user is not allowed to look (${found.captureBlocked})`);
  } else if (found.capture) {
    rec("PASS", "Request memory (pgnet_lens) is set up");
  } else {
    rec(
      "INFO",
      "Request memory (pgnet_lens)",
      "not set up. Optional: run `pgnet-lens init` to also record what was sent"
    );
  }

  const fails = results.filter((s) => s === "FAIL").length;
  const warns = results.filter((s) => s === "WARN").length;
  console.log(
    `\n${fails === 0 ? "All good" : "Problems found"}: ` +
      `${results.length - fails - warns} ok, ${warns} warnings, ${fails} failed.\n`
  );
  return fails === 0 ? 0 : 1;
}