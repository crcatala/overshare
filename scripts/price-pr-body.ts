/**
 * The body of the price-update bot's PR, from an `update:prices --json` summary (see scripts/price-bot.sh).
 *
 *   tsx scripts/price-pr-body.ts <summary.json> --tests pass|fail --run-url <url> --base <branch>
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { renderPrBody, type PrBodySummary } from "./prices.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { tests: { type: "string" }, "run-url": { type: "string" }, base: { type: "string" } },
});
const [file] = positionals;
if (!file || (values.tests !== "pass" && values.tests !== "fail") || !values["run-url"] || !values.base) {
  console.error("usage: tsx scripts/price-pr-body.ts <summary.json> --tests pass|fail --run-url <url> --base <branch>");
  process.exit(2);
}
const summary = JSON.parse(readFileSync(file, "utf8")) as PrBodySummary;
process.stdout.write(renderPrBody(summary, { tests: values.tests, runUrl: values["run-url"], base: values.base }));
