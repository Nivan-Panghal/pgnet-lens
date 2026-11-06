// `pgnet-lens init`: installs (or removes) the optional request memory.
import readline from "node:readline/promises";
import { CAPTURE_SQL, CAPTURE_SUMMARY, REMOVE_SQL } from "./capture-sql.js";
import { UserError } from "./db.js";

async function confirm(question) {
  if (!process.stdin.isTTY) {
    throw new UserError("This needs a yes/no answer. Run it in a terminal, or add --yes.");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question + " [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function runInit(conn, target, flags) {
  if (flags.print) {
    console.log(flags.remove ? REMOVE_SQL : CAPTURE_SQL);
    return 0;
  }

  if (flags.remove) {
    console.log(`\nThis will delete the pgnet_lens area from ${target.host} / ${target.database},`);
    console.log("including all remembered requests. Your own tables are not touched.\n");
    if (!flags.yes && !(await confirm("Remove it?"))) {
      console.log("Nothing changed.");
      return 0;
    }
    await conn.query(REMOVE_SQL);
    console.log("Removed.");
    return 0;
  }

  console.log(`\nSetting up request memory on ${target.host} / ${target.database}\n`);
  for (const line of CAPTURE_SUMMARY) console.log("  " + line);
  console.log("\nTo read the exact SQL first, run:  pgnet-lens init --print\n");

  if (!flags.yes && !(await confirm("Apply this?"))) {
    console.log("Nothing changed.");
    return 0;
  }

  await conn.query("begin;\n" + CAPTURE_SQL + "\ncommit;");
  console.log("\nDone. To record a request, use pgnet_lens.http_post(...) instead of");
  console.log("net.http_post(...) in your SQL. Same inputs, same result.\n");
  return 0;
}