// watch / list / show
import path from "node:path";
import { Store } from "./store.js";
import { explain } from "./explain.js";
import { syncOnce } from "./sync.js";
import { fingerprint, isConnectionLevelError } from "./db.js";
import { fmtClock, fmtTime, hostOf, renderTable, truncate } from "./format.js";

export function openStore(url, flags) {
  const dir = path.resolve(flags.dir || ".pgnet-lens");
  return new Store(path.join(dir, `history-${fingerprint(url)}.jsonl`));
}

function describe(row) {
  return explain({
    status: row.status,
    timedOut: row.timedOut,
    error: row.error,
    url: row.url,
    hasResponse: row.hasResponse,
  });
}

function whereFrom(row) {
  if (row.table) return row.hookName ? `${row.table} (${row.hookName})` : row.table;
  if (row.url) return hostOf(row.url) ?? row.url;
  return "-";
}

const firstSentence = (t) => (t.match(/^.*?[.!?](\s|$)/)?.[0] ?? t).trim();

function resultLabel(row, ex) {
  const code = row.status != null ? ` ${row.status}` : "";
  return `${ex.label}${row.status != null && ex.label === "Worked" ? code : ""}`;
}

// ---------------------------------------------------------------- watch
export async function runWatch(conn, target, url, flags) {
  const store = openStore(url, flags);
  const state = {};
  const intervalSec = Math.max(1, Number(flags.interval) || 2);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`\nWatching ${target.host} / ${target.database}`);
  console.log(`Saving history to ${store.file}`);
  if (!flags.once) console.log("Press Ctrl+C to stop.\n");

  let first = true;
  let announcedHooks = false;
  let failuresInARow = 0;

  while (!stopping) {
    try {
      const { added, found } = await syncOnce(conn, store, state, {
        noBodies: Boolean(flags["no-bodies"]),
      });
      failuresInARow = 0;

      if (first) {
        console.log(
          `Caught up: ${added.responses.length} new replies saved` +
            (found.hooks ? `, ${added.hooks} webhook records` : "") +
            (found.capture ? `, ${added.requests} remembered requests` : "") +
            ".\n"
        );
        first = false;
      } else if (added.responses.length > 0) {
        const view = new Map(store.view().map((r) => [r.id, r]));
        for (const id of added.responses) {
          const row = view.get(id);
          if (row) console.log(formatLine(row));
        }
      }
      if (found.hooks && !announcedHooks) announcedHooks = true;
    } catch (e) {
      const msg = String(e?.message ?? e).split("\n")[0];
      if (!isConnectionLevelError(e)) {
        // The database answered but refused. Retrying will not help.
        console.log(`\n✘ The database refused a read: ${msg}`);
        console.log("  Run `pgnet-lens doctor` to see what this user can and cannot read.");
        process.exitCode = 1;
        break;
      }
      failuresInARow++;
      console.log(`! Could not reach the database (${msg}). Retrying...`);
      if (flags.once) {
        process.exitCode = 1;
        break;
      }
    }
    if (flags.once) break;
    const wait = Math.min(30, intervalSec * Math.max(1, failuresInARow)) * 1000;
    await sleepUnlessStopped(wait, () => stopping);
  }

  await conn.close();
  if (!flags.once) console.log("\nStopped.");
  return process.exitCode ?? 0;
}

function formatLine(row) {
  const ex = describe(row);
  const mark = ex.tone === "ok" ? "✔" : ex.tone === "warn" ? "!" : "✘";
  return (
    `${fmtClock(row.time)}  ${mark} #${row.id}  ${resultLabel(row, ex)}  ` +
    `${truncate(whereFrom(row), 40)}`
  );
}

async function sleepUnlessStopped(ms, isStopped) {
  const step = 200;
  for (let waited = 0; waited < ms && !isStopped(); waited += step) {
    await new Promise((r) => setTimeout(r, step));
  }
}

// ----------------------------------------------------------------- list
export function runList(url, flags) {
  const store = openStore(url, flags);
  let rows = store.view();
  if (flags.failed) rows = rows.filter((r) => describe(r).tone !== "ok");
  const limit = Math.max(1, Number(flags.limit) || 20);
  const shown = rows.slice(0, limit);

  if (shown.length === 0) {
    console.log(
      rows.length === 0 && store.items.length === 0
        ? "\nNo history yet. Run `pgnet-lens watch` first.\n"
        : "\nNothing matches.\n"
    );
    return 0;
  }

  const table = shown.map((r) => {
    const ex = describe(r);
    return {
      id: `#${r.id}`,
      time: fmtTime(r.time),
      result: resultLabel(r, ex),
      from: whereFrom(r),
      note: firstSentence(ex.text),
    };
  });
  console.log(
    "\n" +
      renderTable(table, [
        { key: "id", title: "ID", max: 10 },
        { key: "time", title: "TIME", max: 19 },
        { key: "result", title: "RESULT", max: 22 },
        { key: "from", title: "FROM", max: 34 },
        { key: "note", title: "WHAT HAPPENED", max: 70 },
      ])
  );
  console.log(`\nShowing ${shown.length} of ${rows.length}. Use \`pgnet-lens show <id>\` for details.\n`);
  return 0;
}

// ----------------------------------------------------------------- show
export function runShow(url, id, flags) {
  const store = openStore(url, flags);
  const clean = String(id ?? "").replace(/^#/, "");
  const row = store.view().find((r) => r.id === clean);
  if (!row) {
    console.log(`\nNo saved record with id ${clean}. Try \`pgnet-lens list\`.\n`);
    return 1;
  }
  const ex = describe(row);
  const limit = flags.full ? Infinity : 2000;
  const showBody = (v) => {
    if (v == null) return "(none)";
    const text = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    return text.length > limit ? text.slice(0, limit) + `\n... (cut off, use --full to see everything)` : text;
  };
  const indent = (t) => t.split("\n").map((l) => "    " + l).join("\n");

  console.log(`\nRequest #${row.id}  -  ${ex.label}`);
  console.log(`  ${ex.text}\n`);
  console.log(`When:     ${fmtTime(row.time)}`);
  const cameFrom = row.table
    ? row.table + (row.hookName ? ` (webhook "${row.hookName}")` : "")
    : row.source === "recorded"
      ? "your own SQL code (not a Database Webhook)"
      : "unknown (not a Database Webhook, or the webhook list is not available)";
  console.log(`Came from: ${cameFrom}`);
  console.log(`Sent to:  ${row.url ? `${row.method ?? "?"} ${row.url}` : "not recorded (run `pgnet-lens init` to record requests)"}`);
  if (row.requestHeaders) console.log(`Headers sent:\n${indent(showBody(row.requestHeaders))}`);
  if (row.source === "recorded") console.log(`Data sent:\n${indent(showBody(row.requestBody))}`);
  else console.log("Data sent: not recorded (run `pgnet-lens init` and use pgnet_lens.http_post)");
  console.log("");
  console.log(`Reply:    ${row.hasResponse ? (row.status != null ? `status ${row.status}` : "no status") : "none saved"}`);
  if (row.error) console.log(`Error:    ${row.error}`);
  if (row.responseHeaders) console.log(`Reply headers:\n${indent(showBody(row.responseHeaders))}`);
  if (row.hasResponse) {
    console.log(`Reply body:\n${indent(showBody(row.responseBody))}`);
    if (row.responseBodyTruncated) console.log("    (the saved copy was shortened to 20000 characters)");
  }
  console.log("");
  return 0;
}