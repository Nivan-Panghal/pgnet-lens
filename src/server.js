// `pgnet-lens serve`: a small page on your own computer that shows the saved
// history and keeps copying new replies while it is open.
//
// Safety rules (a page on localhost must not be usable by other websites):
//  - it only listens on 127.0.0.1, never on your network
//  - every data request needs a private key that is only in the link we print
//  - requests with a wrong Host or Origin header are refused
//  - the page draws data as plain text only, never as HTML
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { UserError, isConnectionLevelError } from "./db.js";
import { explain } from "./explain.js";
import { hostOf } from "./format.js";
import { openStore } from "./commands.js";
import { syncOnce } from "./sync.js";

const PAGE = fs.readFileSync(fileURLToPath(new URL("./page.html", import.meta.url)), "utf8");

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const firstLine = (e) => String(e?.message ?? e).split("\n")[0];

function summarize(r) {
  const ex = explain({
    status: r.status,
    timedOut: r.timedOut,
    error: r.error,
    url: r.url,
    hasResponse: r.hasResponse,
  });
  return {
    id: r.id,
    time: r.time,
    label: ex.label,
    tone: ex.tone,
    text: ex.text,
    status: r.status,
    from: r.table
      ? r.hookName
        ? `${r.table} (${r.hookName})`
        : r.table
      : r.url
        ? (hostOf(r.url) ?? r.url)
        : "-",
    source: r.source,
    canResend: r.source === "recorded",
    stamp: `${r.hasResponse ? 1 : 0}|${r.status ?? ""}|${r.error ?? ""}|${r.source}`,
  };
}

function detail(r) {
  return {
    ...summarize(r),
    hasResponse: r.hasResponse,
    error: r.error,
    table: r.table,
    hookName: r.hookName,
    method: r.method,
    url: r.url,
    requestHeaders: r.requestHeaders,
    requestParams: r.requestParams,
    requestBody: r.requestBody,
    responseHeaders: r.responseHeaders,
    responseBody: r.responseBody,
    responseBodyTruncated: r.responseBodyTruncated,
  };
}

function sameToken(given, expected) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function listen(server, wanted) {
  const explicit = wanted !== undefined && wanted !== null && wanted !== "";
  let port = explicit ? Number(wanted) : 7411;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UserError("--port must be a whole number between 0 and 65535.");
  }
  const attempts = explicit ? 1 : 10;
  return new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = () => {
      const onError = (e) => {
        if (e.code === "EADDRINUSE" && tries < attempts - 1) {
          tries++;
          port++;
          attempt();
        } else if (e.code === "EADDRINUSE") {
          reject(new UserError(`Port ${port} is already in use. Try --port <another number>.`));
        } else {
          reject(e);
        }
      };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve(server.address().port);
      });
    };
    attempt();
  });
}

function openBrowser(link) {
  try {
    let child;
    if (process.platform === "win32") {
      child = spawn("cmd", ["/c", "start", "", link], { stdio: "ignore", detached: true });
    } else if (process.platform === "darwin") {
      child = spawn("open", [link], { stdio: "ignore", detached: true });
    } else {
      child = spawn("xdg-open", [link], { stdio: "ignore", detached: true });
    }
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the link is printed anyway */
  }
}

/**
 * Starts the page and the background copying. Returns a handle:
 * { port, token, link, stop() }. Used by `runServe` and by the tests.
 */
export async function startServer(conn, target, url, flags, log = console.log) {
  const store = openStore(url, flags);
  const syncState = {};
  const token = crypto.randomBytes(16).toString("hex");
  const status = { lastSyncAt: null, lastError: null, capture: false, hooks: false };
  const intervalMs = Math.max(1, Number(flags.interval) || 2) * 1000;
  const noBodies = Boolean(flags["no-bodies"]);
  let stopping = false;
  let allowedHosts = new Set();

  const send = (res, code, headers, body) => {
    res.writeHead(code, headers);
    res.end(body);
  };
  const sendJson = (res, code, data) =>
    send(
      res,
      code,
      {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
      JSON.stringify(data)
    );

  async function handleResend(res, id) {
    const row = store.view().find((r) => r.id === id);
    if (!row) return sendJson(res, 404, { error: `No saved request with id ${id}.` });
    if (row.source !== "recorded") {
      return sendJson(res, 409, {
        error:
          "This request was not recorded, so it cannot be sent again. Supabase does not keep " +
          "what dashboard webhooks send. Requests sent with pgnet_lens.http_post can be.",
      });
    }
    try {
      const r = await conn.query("select pgnet_lens.resend($1::bigint)::text as id", [id]);
      const newId = r.rows[0].id;
      log(`Sent #${id} again as #${newId}`);
      return sendJson(res, 200, { newId });
    } catch (e) {
      if (e?.code === "42883") {
        return sendJson(res, 409, {
          error:
            "Your database has an older setup without the send-again feature. " +
            "Run `pgnet-lens init` once more, then try again.",
        });
      }
      if (e?.code === "42501") {
        return sendJson(res, 403, {
          error: "This database user is not allowed to send requests. Use the owner's link.",
        });
      }
      if (e?.code === "P0001") return sendJson(res, 404, { error: firstLine(e) });
      if (isConnectionLevelError(e)) {
        return sendJson(res, 502, { error: "Could not reach the database. Try again." });
      }
      return sendJson(res, 500, { error: `Could not send it again: ${firstLine(e)}` });
    }
  }

  const handler = async (req, res) => {
    try {
      const host = String(req.headers.host ?? "").toLowerCase();
      if (!allowedHosts.has(host)) return send(res, 403, { "Content-Type": "text/plain" }, "Forbidden");

      const reqUrl = new URL(req.url, `http://${host}`);
      const path = reqUrl.pathname;

      if (req.method === "GET" && path === "/") {
        return send(res, 200, PAGE_HEADERS, PAGE);
      }
      if (!path.startsWith("/api/")) {
        return send(res, 404, { "Content-Type": "text/plain" }, "Not found");
      }

      // Everything under /api needs the private key.
      if (!sameToken(req.headers["x-token"], token)) {
        return sendJson(res, 401, {
          error: "This page needs the link printed by `pgnet-lens serve` (it contains a private key).",
        });
      }
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) {
        return sendJson(res, 403, { error: "Forbidden" });
      }

      if (req.method === "GET" && path === "/api/status") {
        return sendJson(res, 200, {
          target: { host: target.host, database: target.database },
          lastSyncAt: status.lastSyncAt,
          lastError: status.lastError,
          capture: status.capture,
          hooks: status.hooks,
          total: store.view().length,
        });
      }

      if (req.method === "GET" && path === "/api/requests") {
        const problemsOnly = reqUrl.searchParams.get("filter") === "problems";
        const limit = Math.min(500, Math.max(1, Number(reqUrl.searchParams.get("limit")) || 200));
        let items = store.view().map(summarize);
        if (problemsOnly) items = items.filter((i) => i.tone !== "ok");
        return sendJson(res, 200, { items: items.slice(0, limit) });
      }

      let m = path.match(/^\/api\/requests\/(\d{1,18})$/);
      if (req.method === "GET" && m) {
        const row = store.view().find((r) => r.id === m[1]);
        if (!row) return sendJson(res, 404, { error: `No saved request with id ${m[1]}.` });
        return sendJson(res, 200, detail(row));
      }

      m = path.match(/^\/api\/requests\/(\d{1,18})\/resend$/);
      if (req.method === "POST" && m) {
        req.resume();
        return await handleResend(res, m[1]);
      }

      return sendJson(res, 404, { error: "Not found" });
    } catch (e) {
      try {
        sendJson(res, 500, { error: "Something went wrong." });
      } catch {
        /* response already started */
      }
    }
  };

  const server = http.createServer(handler);
  const port = await listen(server, flags.port);
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const link = `http://127.0.0.1:${port}/?t=${token}`;

  // Keep copying new replies while the page is open.
  const sleep = async (ms) => {
    for (let waited = 0; waited < ms && !stopping; waited += 100) {
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const loop = (async () => {
    let lastLogged = null;
    while (!stopping) {
      let wait = intervalMs;
      try {
        const { found } = await syncOnce(conn, store, syncState, { noBodies });
        status.lastSyncAt = new Date().toISOString();
        status.lastError = null;
        status.capture = found.capture;
        status.hooks = found.hooks;
        lastLogged = null;
      } catch (e) {
        status.lastError = firstLine(e);
        wait = Math.max(intervalMs, 10_000);
        if (lastLogged !== status.lastError) {
          log(`! Could not read the database: ${status.lastError}`);
          lastLogged = status.lastError;
        }
      }
      await sleep(wait);
    }
  })();

  return {
    port,
    token,
    link,
    async stop() {
      stopping = true;
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      await loop;
      await conn.close();
    },
  };
}

export async function runServe(conn, target, url, flags) {
  const handle = await startServer(conn, target, url, flags);

  console.log(`\nWatching ${target.host} / ${target.database}`);
  console.log("Open this link in your browser (it contains a private key, do not share it):\n");
  console.log(`  ${handle.link}\n`);
  console.log("Press Ctrl+C to stop.\n");
  if (!flags["no-open"]) openBrowser(handle.link);

  await new Promise((resolve) => {
    const done = () => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await handle.stop();
  console.log("\nStopped.");
  return 0;
}