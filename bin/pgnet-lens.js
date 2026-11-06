#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Connection, UserError, describeTarget, resolveDatabaseUrl } from "../src/db.js";
import { runDoctor } from "../src/doctor.js";
import { runInit } from "../src/init.js";
import { runList, runShow, runWatch } from "../src/commands.js";

const HELP = `
pgnet-lens - a free local flight recorder for Supabase webhooks and pg_net.

Supabase keeps webhook replies for only 6 hours and does not keep what was
sent. pgnet-lens copies them to your own computer and explains failures.

Usage:
  pgnet-lens doctor            Check that the database can be read
  pgnet-lens watch             Copy new replies to this computer (Ctrl+C to stop)
  pgnet-lens list              Show saved history
  pgnet-lens show <id>         Show everything about one request
  pgnet-lens init              (optional) Also remember what was sent

Options:
  --db <link>        Database link (or set the DATABASE_URL variable)
  --dir <folder>     Where history is saved (default: .pgnet-lens)
  --interval <sec>   watch: seconds between checks (default 2)
  --once             watch: copy once and stop
  --no-bodies        watch: do not save message contents
  --failed           list: only show problems
  --limit <n>        list: how many rows (default 20)
  --full             show: do not cut long contents
  --print            init: only print the SQL
  --remove           init: remove the optional setup
  --yes              init: do not ask for confirmation
  -h, --help         Show this help
`;

const options = {
  db: { type: "string" },
  dir: { type: "string" },
  interval: { type: "string" },
  once: { type: "boolean" },
  "no-bodies": { type: "boolean" },
  failed: { type: "boolean" },
  limit: { type: "string" },
  full: { type: "boolean" },
  print: { type: "boolean" },
  remove: { type: "boolean" },
  yes: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

// Quietly stop if the reader closes the pipe (for example `... | head`).
process.stdout.on("error", (e) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

async function main() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 18 || (major === 18 && minor < 3)) {
    throw new UserError(`Node.js 18.3 or newer is required (you have ${process.versions.node}).`);
  }

  let parsed;
  try {
    parsed = parseArgs({ options, allowPositionals: true });
  } catch (e) {
    throw new UserError(`${e.message}\nRun with --help to see the options.`);
  }
  const { values: flags, positionals } = parsed;
  const [command, arg] = positionals;

  if (flags.help || !command) {
    console.log(HELP);
    return 0;
  }

  const known = ["doctor", "watch", "list", "show", "init"];
  if (!known.includes(command)) {
    throw new UserError(`Unknown command "${command}". Run with --help.`);
  }

  // Commands that only read the saved history still need the link, so we can
  // tell which database the history belongs to. They never connect.
  const needsLink = !(command === "init" && flags.print);
  const url = needsLink ? resolveDatabaseUrl(flags) : null;
  const target = url ? describeTarget(url) : null;

  if (command === "list") return runList(url, flags);
  if (command === "show") {
    if (!arg) throw new UserError("Which request? Example: pgnet-lens show 12");
    return runShow(url, arg, flags);
  }

  const conn = new Connection(url);
  try {
    if (command === "doctor") return await runDoctor(conn, target);
    if (command === "init") return await runInit(conn, target, flags);
    if (command === "watch") return await runWatch(conn, target, url, flags);
  } finally {
    await conn.close();
  }
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    if (e instanceof UserError) {
      console.error(`\n${e.message}\n`);
    } else {
      console.error(`\nSomething went wrong: ${String(e?.message ?? e).split("\n")[0]}\n`);
    }
    process.exit(1);
  });