// Database connection helpers. We only ever connect with the link the user
// gives us, and we never print the link or the password.
import crypto from "node:crypto";
import pg from "pg";

export class UserError extends Error {}

export function resolveDatabaseUrl(flags) {
  const url = flags.db || process.env.DATABASE_URL;
  if (!url) {
    throw new UserError(
      "No database link given.\n" +
        "Use --db or set DATABASE_URL. In PowerShell:\n" +
        "  $env:DATABASE_URL='postgresql://...your connection string...'"
    );
  }
  return url;
}

/** Host / database / user for display. Never includes the password. */
export function describeTarget(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || "5432",
      database: u.pathname.replace(/^\//, "") || "postgres",
      user: decodeURIComponent(u.username || ""),
    };
  } catch {
    return { host: "(unreadable link)", port: "", database: "", user: "" };
  }
}

/** Short stable id for a database, used in the history file name. */
export function fingerprint(url) {
  const t = describeTarget(url);
  return crypto
    .createHash("sha1")
    .update(`${t.host}|${t.port}|${t.database}|${t.user}`)
    .digest("hex")
    .slice(0, 8);
}

export function isConnectionLevelError(e) {
  const code = typeof e?.code === "string" ? e.code : "";
  const looksLikeSqlState = /^[0-9A-Z]{5}$/.test(code);
  if (!looksLikeSqlState) return true; // network errors like ECONNRESET
  return code.startsWith("08") || code.startsWith("57");
}

export class Connection {
  constructor(url) {
    this.url = url;
    this._client = null;
  }

  async client() {
    if (this._client) return this._client;
    const { host } = describeTarget(this.url);
    const isLocal = host === "localhost" || host === "127.0.0.1";
    const client = new pg.Client({
      connectionString: this.url,
      // Hosted Supabase needs an encrypted connection.
      ssl: isLocal ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
      application_name: "pgnet-lens",
    });
    client.on("error", () => {
      this._client = null;
    });
    await client.connect();
    this._client = client;
    return client;
  }

  async query(text, params) {
    try {
      const client = await this.client();
      return await client.query(text, params);
    } catch (e) {
      if (isConnectionLevelError(e)) await this.reset();
      throw e;
    }
  }

  async reset() {
    const c = this._client;
    this._client = null;
    if (c) {
      try {
        await c.end();
      } catch {
        /* ignore */
      }
    }
  }

  async close() {
    await this.reset();
  }
}