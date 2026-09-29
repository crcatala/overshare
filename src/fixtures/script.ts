import type { Rng } from "./random.js";
import type { FixtureSecrets } from "./secrets.js";

/**
 * A harness-neutral description of a coding session. Emitters (claude-code.ts, pi.ts)
 * turn it into each harness's native transcript format. The story is a realistic
 * debugging/feature session on a fake billing API and deliberately touches every
 * viewer feature and redaction path.
 */

export type ToolKind = "read" | "edit" | "write" | "bash" | "grep" | "glob" | "web" | "todo" | "mcp";

export interface ToolCall {
  kind: ToolKind;
  path?: string;
  command?: string;
  pattern?: string;
  url?: string;
  oldText?: string;
  newText?: string;
  content?: string;
  output: string;
  isError?: boolean;
  /** Result includes a screenshot image. */
  image?: boolean;
  /** Harness-specific tool (skipped by harnesses that lack it). */
  only?: "claude-code" | "pi";
}

export interface SubagentCall {
  agents: string[];
  description: string;
  prompt: string;
  output: string;
  usage: { input: number; output: number; cacheRead: number; turns: number; toolUses: number; durationMs: number; cost: number };
}

export type Block =
  | { k: "thinking"; text: string; tokens: number }
  | { k: "text"; text: string }
  | { k: "tool"; call: ToolCall }
  | { k: "subagent"; call: SubagentCall }
  /** pi-only management call to the subagent tool (list/status). */
  | { k: "subagentList" };

export type Item =
  | { t: "prompt"; text: string; image?: boolean; reminder?: boolean }
  | { t: "command"; name: string; stdout: string }
  | { t: "commandPrompt"; name: string; args?: string; expanded: string }
  | { t: "skill"; name: string }
  | { t: "response"; blocks: Block[] }
  | { t: "interrupt" }
  | { t: "apiError"; text: string }
  | { t: "compaction"; summary: string }
  | { t: "modelChange"; model: string }
  | { t: "thinkingLevel"; level: string }
  | { t: "queuedPrompt"; text: string }
  | { t: "subagentNotice"; text: string }
  /** Items the user later rewound/branched away from (must not appear in exports). */
  | { t: "abandoned"; items: Item[] };

export interface SessionScript {
  cwd: string;
  project: string;
  title: string;
  items: Item[];
  /** Text that only occurs inside abandoned branches (tests assert it is not exported). */
  abandonedMarker: string;
}

const tool = (call: ToolCall): Block => ({ k: "tool", call });
const think = (text: string, tokens: number): Block => ({ k: "thinking", text, tokens });
const text = (t: string): Block => ({ k: "text", text: t });

export function buildScript(rng: Rng, opts: { home: string; username: string; secrets: FixtureSecrets; extraTurns: number }): SessionScript {
  const project = "acme-billing-api";
  const cwd = `${opts.home}/workspace/${project}`;
  const s = opts.secrets.byLabel;
  const n = () => rng.int(2, 9);
  const invoiceLine = rng.int(40, 90);
  const maintainer = rng.pick(["jordan.lee", "sam.okafor", "priya.raman", "alex.moreau"]);
  const branch = `fix/invoice-currency-${rng.hex(4)}`;
  const prNumber = rng.int(120, 480);

  const items: Item[] = [
    {
      t: "prompt",
      reminder: true,
      text: `POST /v1/invoices returns a 500 when the request has no \`currency\` field. It should default to the customer's currency, and fall back to USD. Can you track it down and fix it? Repro:\n\n\`\`\`bash\ncurl -s -X POST localhost:4000/v1/invoices -H 'content-type: application/json' -d '{"customerId":"cus_${rng.token(10)}","lines":[{"sku":"PRO-MONTHLY","qty":1}]}'\n\`\`\``,
    },
    {
      t: "response",
      blocks: [
        think("The 500 probably comes from a currency lookup on undefined. Let me find where invoices are created and how currency is resolved.", 180),
        text("I'll find where invoice creation resolves the currency."),
        tool({ kind: "grep", pattern: "currency", path: "src", output: `src/invoices/create.ts:${invoiceLine}:  const rate = rates[body.currency.toUpperCase()];\nsrc/invoices/schema.ts:14:  currency: z.string().length(3),\nsrc/customers/model.ts:22:  currency: string;\nsrc/lib/money.ts:8:export function toMinorUnits(amount: number, currency: string) {` }),
      ],
    },
    {
      t: "response",
      blocks: [
        tool({ kind: "read", path: `${cwd}/src/invoices/create.ts`, output: createTs(invoiceLine) }),
        tool({ kind: "read", path: `${cwd}/src/invoices/schema.ts`, output: schemaTs() }),
      ],
    },
    {
      t: "response",
      blocks: [
        think("schema.ts requires currency but the route doesn't validate before using it. body.currency is undefined → .toUpperCase() throws. Fix: make currency optional in the schema and resolve it from the customer, defaulting to USD.", 240),
        tool({
          kind: "bash",
          command: "npm test -- src/invoices",
          isError: true,
          output: `> acme-billing-api@2.3.1 test\n> vitest run src/invoices\n\n ❯ src/invoices/create.test.ts (6 tests | 1 failed) 41ms\n   × creates an invoice without currency\n     → TypeError: Cannot read properties of undefined (reading 'toUpperCase')\n       at createInvoice (src/invoices/create.ts:${invoiceLine}:39)\n\n Test Files  1 failed (1)\n      Tests  1 failed | 5 passed (6)`,
        }),
      ],
    },
    {
      t: "response",
      blocks: [
        tool({
          kind: "edit",
          path: `${cwd}/src/invoices/create.ts`,
          oldText: "  const rate = rates[body.currency.toUpperCase()];",
          newText: "  const currency = (body.currency ?? customer.currency ?? \"USD\").toUpperCase();\n  const rate = rates[currency];",
          output: "The file has been updated successfully.",
        }),
        tool({
          kind: "edit",
          path: `${cwd}/src/invoices/schema.ts`,
          oldText: "  currency: z.string().length(3),",
          newText: "  currency: z.string().length(3).optional(),",
          output: "The file has been updated successfully.",
        }),
      ],
    },
    {
      t: "response",
      blocks: [
        tool({ kind: "bash", command: "npm test -- src/invoices", output: `> vitest run src/invoices\n\n ✓ src/invoices/create.test.ts (6 tests) 38ms\n ✓ src/invoices/schema.test.ts (4 tests) 6ms\n\n Test Files  2 passed (2)\n      Tests  10 passed (10)` }),
      ],
    },
    {
      t: "response",
      blocks: [
        text(
          `Fixed. The route dereferenced \`body.currency\` before validation, so a missing field threw inside \`createInvoice\`.\n\n**Changes**\n- \`src/invoices/schema.ts\` — \`currency\` is now optional\n- \`src/invoices/create.ts\` — resolve currency as *request → customer → \`USD\`*\n\n| Case | Before | After |\n| --- | --- | --- |\n| currency given | 201 | 201 |\n| no currency, customer has one | 500 | 201 (customer's) |\n| no currency anywhere | 500 | 201 (USD) |\n\nAll 10 invoice tests pass.`,
        ),
      ],
    },
    { t: "command", name: "/model", stdout: "Set model to claude-opus-5-5" },
    { t: "modelChange", model: "claude-opus-5-5" },
    { t: "prompt", text: "Great. Add a regression test for the USD fallback, and update the todo list so we track the follow-ups." },
    {
      t: "response",
      blocks: [
        tool({
          kind: "todo",
          only: "claude-code",
          output: "Todos have been modified successfully.",
          content: JSON.stringify([
            { content: "Regression test for USD fallback", status: "in_progress" },
            { content: "Check integration tests against local Postgres", status: "pending" },
            { content: "Open PR", status: "pending" },
          ]),
        }),
        tool({ kind: "write", path: `${cwd}/src/invoices/currency.test.ts`, content: currencyTest(), output: `File created successfully at: ${cwd}/src/invoices/currency.test.ts` }),
        tool({ kind: "bash", command: "npm test -- src/invoices/currency.test.ts", output: " ✓ src/invoices/currency.test.ts (3 tests) 12ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)" }),
      ],
    },
    { t: "response", blocks: [text("Added `src/invoices/currency.test.ts` with three cases (explicit, customer default, USD fallback). All pass.")] },
    // --- Secrets: env dump + .env file (the classic leak) ---
    { t: "prompt", text: "The integration tests can't connect to Postgres locally. Can you check my environment and .env and tell me what's wrong?" },
    {
      t: "response",
      blocks: [
        think("Let me look at the env vars the test harness reads, and the .env file.", 90),
        tool({
          kind: "bash",
          command: "env | sort",
          output: [
            `ANTHROPIC_API_KEY=${s.ANTHROPIC_API_KEY}`,
            `AWS_ACCESS_KEY_ID=${s.AWS_ACCESS_KEY_ID}`,
            `AWS_SECRET_ACCESS_KEY=${s.AWS_SECRET_ACCESS_KEY}`,
            `ACME_INTERNAL_TOKEN=${s.ACME_INTERNAL_TOKEN}`,
            `DATABASE_URL=postgres://billing:${s.DATABASE_URL_PASSWORD}@localhost:5433/billing_test`,
            `GITHUB_TOKEN=${s.GITHUB_TOKEN}`,
            `HOME=${opts.home}`,
            "NODE_ENV=test",
            `PATH=${opts.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
            `PWD=${cwd}`,
            `SLACK_BOT_TOKEN=${s.SLACK_BOT_TOKEN}`,
            `STRIPE_SECRET_KEY=${s.STRIPE_SECRET_KEY}`,
            `USER=${opts.username}`,
          ].join("\n"),
        }),
        tool({
          kind: "read",
          path: `${cwd}/.env`,
          output: `DB_HOST=localhost\nDB_PORT=5432\nDB_USER=billing\nDB_PASSWORD=${s.DB_PASSWORD}\nSESSION_JWT=${s.SESSION_JWT}\nMAINTAINER_EMAIL=${maintainer}@acme-billing.io\n`,
        }),
        tool({ kind: "bash", command: "cat deploy/staging-deploy.pem | head -8", output: s.DEPLOY_KEY ?? "" }),
      ],
    },
    {
      t: "response",
      blocks: [
        text(
          `Found it: \`DATABASE_URL\` points at port **5433**, but \`.env\` (and docker-compose) use **5432**. The test harness prefers \`DATABASE_URL\` when it is set, so it never reads \`DB_PORT\`.\n\nEither \`unset DATABASE_URL\` in this shell or change it to \`:5432\`. If it keeps failing, ${maintainer}@acme-billing.io owns the test infra.\n\n> Heads-up: that \`env\` output also contains live-looking credentials (GitHub, Stripe, Slack, AWS). Avoid pasting it anywhere public.`,
        ),
      ],
    },
    // --- Review command + subagent ---
    {
      t: "commandPrompt",
      name: "/review",
      args: "src/invoices",
      expanded: "Review the changes in src/invoices for correctness, edge cases and missing tests. Delegate a deep read of related modules to a subagent, then summarise findings as a table.",
    },
    { t: "skill", name: "code-review" },
    {
      t: "response",
      blocks: [
        { k: "subagentList" },
        {
          k: "subagent",
          call: {
            agents: ["Explore", "reviewer"],
            description: "Audit currency handling across billing modules",
            prompt: "Find every place that reads or converts currency and report inconsistencies with the new fallback.",
            output: "Found 3 call sites. `src/lib/money.ts:toMinorUnits` assumes 2 decimals — wrong for JPY (0) and KWD (3). `src/reports/revenue.ts` sums amounts across currencies without converting.",
            usage: { input: rng.int(20_000, 60_000), output: rng.int(3_000, 9_000), cacheRead: rng.int(200_000, 900_000), turns: rng.int(8, 30), toolUses: rng.int(10, 40), durationMs: rng.int(40_000, 240_000), cost: rng.int(8, 60) / 100 },
          },
        },
      ],
    },
    { t: "subagentNotice", text: "Background task completed: **workflow** — 2 child runs." },
    {
      t: "response",
      blocks: [
        text(
          [
            "## Review of `src/invoices`",
            "",
            "| Severity | Finding | Where |",
            "| --- | --- | --- |",
            "| 🔴 High | `toMinorUnits` assumes 2 decimals; JPY/KWD invoices are off by 100× / 10× | `src/lib/money.ts:8` |",
            "| 🟠 Medium | Revenue report adds amounts across currencies | `src/reports/revenue.ts:31` |",
            "| 🟢 Low | No test for lowercase currency codes | `src/invoices/currency.test.ts` |",
            "",
            "The fallback itself looks correct.",
            "",
            "### How currency flows today",
            "",
            "```text",
            "request.body.currency ─┐",
            "                       ├─► createInvoice() ─► toMinorUnits(total, currency) ─► Stripe",
            "customer.currency ─────┘         │",
            "                                 └─► revenue report (sums minor units across currencies ✗)",
            "```",
            "",
            "### Currency exponents we need to support",
            "",
            "| Code | Name | Minor unit exponent | Stripe treats it as | Example: 1,234.5 → minor units | Notes |",
            "| :--- | :--- | :---: | :--- | ---: | :--- |",
            "| USD | US dollar | 2 | standard | 123450 | default fallback when neither request nor customer sets one |",
            "| JPY | Japanese yen | 0 | zero-decimal | 1235 | rounds half-up; the dashboard showed these 100× too large |",
            "| KWD | Kuwaiti dinar | 3 | three-decimal | 1234500 | Stripe requires the last digit to be 0 for card payments |",
            "| EUR | Euro | 2 | standard | 123450 | |",
            "",
            "### Suggested follow-ups",
            "",
            "1. Replace the hard-coded `* 100` with an exponent table:",
            "   - derive it from `Intl.NumberFormat(undefined, { style: \"currency\", currency }).resolvedOptions().maximumFractionDigits` so new currencies work without a code change",
            "   - keep an override map for Stripe's special cases (`HUF`, `TWD`, `UGX`)",
            "2. Make the revenue report group by currency *before* summing, or convert with the day's rate.",
            "3. Add a property test: `fromMinorUnits(toMinorUnits(x, c), c) ≈ x` for every supported `c`.",
            "",
            "> None of these block the currency fallback fix, but #1 explains the JPY ticket.",
          ].join("\n"),
        ),
      ],
    },
    // --- Image + web + MCP ---
    { t: "prompt", image: true, text: "Here's a screenshot of the dashboard after the fix — totals for the JPY customer still look wrong. Check Stripe's docs on zero-decimal currencies and the linked ticket." },
    {
      t: "response",
      blocks: [
        tool({ kind: "web", url: "https://docs.stripe.com/currencies#zero-decimal", output: "Zero-decimal currencies\n\nAll API requests expect amounts in the currency's smallest unit. For zero-decimal currencies such as JPY, KRW and VND, provide the amount without multiplying by 100…" }),
        tool({ kind: "mcp", only: "claude-code", output: `{"id":"BILL-${rng.int(100, 999)}","title":"JPY invoices 100x too large","status":"In Progress","assignee":"${maintainer}"}` }),
        tool({ kind: "bash", command: "npx playwright screenshot http://localhost:4000/dashboard /tmp/dashboard.png", image: true, output: `Authenticated as dashboard service account (${s.ACME_INTERNAL_TOKEN})\nScreenshot saved to /tmp/dashboard.png` }),
      ],
    },
    {
      t: "response",
      blocks: [
        text(
          "Confirmed: Stripe treats JPY as zero-decimal, and our `toMinorUnits` multiplies by 100 unconditionally. That matches the ticket. Proposed fix:\n\n```ts\nconst ZERO_DECIMAL = new Set([\"JPY\", \"KRW\", \"VND\"]);\nexport function toMinorUnits(amount: number, currency: string) {\n  return ZERO_DECIMAL.has(currency) ? Math.round(amount) : Math.round(amount * 100);\n}\n```",
        ),
      ],
    },
    // --- Rewind / branch ---
    {
      t: "abandoned",
      items: [
        { t: "prompt", text: "ABANDONED-BRANCH: actually, rewrite the whole money module in Rust with wasm bindings." },
        { t: "response", blocks: [text("That's a big change — before I start, do you want to keep the TypeScript API surface identical?")] },
      ],
    },
    { t: "prompt", text: "Never mind the rewrite. Apply the zero-decimal fix, and add structured logging around invoice creation." },
    {
      t: "response",
      blocks: [
        tool({ kind: "edit", path: `${cwd}/src/lib/money.ts`, oldText: "  return Math.round(amount * 100);", newText: "  return ZERO_DECIMAL.has(currency) ? Math.round(amount) : Math.round(amount * 100);", output: "The file has been updated successfully." }),
        tool({ kind: "bash", command: "npm install winston", output: "added 27 packages in 3s" }),
      ],
    },
    { t: "interrupt" },
    { t: "queuedPrompt", text: "Use pino, not winston — we already use it in the worker service." },
    {
      t: "response",
      blocks: [
        tool({ kind: "bash", command: "npm uninstall winston && npm install pino", output: "removed 27 packages, added 11 packages in 2s" }),
        tool({ kind: "edit", path: `${cwd}/src/invoices/create.ts`, oldText: "export async function createInvoice(", newText: "const log = logger.child({ module: \"invoices\" });\n\nexport async function createInvoice(", output: "The file has been updated successfully." }),
        tool({ kind: "bash", command: "npm run build -- --verbose", output: bigBuildLog(rng) }),
      ],
    },
    { t: "apiError", text: "API Error: 529 Overloaded. Retrying…" },
    { t: "response", blocks: [text("Switched to `pino` with a child logger for the invoices module; the build is green.")] },
    // --- Compaction + model/thinking changes ---
    {
      t: "compaction",
      summary:
        "## Summary so far\n- Fixed 500 on POST /v1/invoices without currency (fallback request → customer → USD)\n- Added regression tests (13 passing)\n- Found DATABASE_URL port mismatch (5433 vs 5432)\n- Review: zero-decimal currency bug in toMinorUnits — fixed\n- Added pino structured logging",
    },
    { t: "thinkingLevel", level: "high" },
    { t: "prompt", text: `Ship it: create a branch, commit, push and open a PR.` },
    {
      t: "response",
      blocks: [
        think("Commit in two logical commits: currency fallback + tests, then zero-decimal fix + logging.", 120),
        tool({ kind: "bash", command: `git checkout -b ${branch} && git add -A && git commit -m "fix(invoices): default currency and zero-decimal amounts"`, output: `Switched to a new branch '${branch}'\n[${branch} ${rng.hex(7)}] fix(invoices): default currency and zero-decimal amounts\n 6 files changed, 118 insertions(+), 9 deletions(-)` }),
        tool({ kind: "bash", command: `git push -u origin ${branch}`, output: `To github.com:acme/${project}.git\n * [new branch]      ${branch} -> ${branch}` }),
        tool({ kind: "bash", command: `gh pr create --fill`, output: `https://github.com/acme/${project}/pull/${prNumber}` }),
      ],
    },
    { t: "response", blocks: [text(`Opened [acme/${project}#${prNumber}](https://github.com/acme/${project}/pull/${prNumber}) from \`${branch}\`.`)] },
  ];

  for (let i = 0; i < opts.extraTurns; i++) items.push(...extraTurn(rng, cwd, n));

  return { cwd, project, title: "Fix 500 on invoices without currency", items, abandonedMarker: "ABANDONED-BRANCH" };
}

const EXTRA_TASKS = [
  { prompt: "Rename `createInvoice` options to `CreateInvoiceInput` everywhere.", file: "src/invoices/create.ts" },
  { prompt: "Add pagination to GET /v1/customers (cursor-based).", file: "src/customers/routes.ts" },
  { prompt: "Why is the webhook handler slow? Profile it.", file: "src/webhooks/stripe.ts" },
  { prompt: "Bump vitest to the latest major and fix breakages.", file: "package.json" },
  { prompt: "Document the currency fallback in the README.", file: "README.md" },
];

function extraTurn(rng: Rng, cwd: string, n: () => number): Item[] {
  const task = rng.pick(EXTRA_TASKS);
  const blocks: Block[] = [think(`Plan for: ${task.prompt}`, rng.int(40, 400))];
  for (let i = 0; i < n(); i++) {
    const kind = rng.pick<ToolKind>(["read", "grep", "bash", "edit"]);
    if (kind === "read") blocks.push(tool({ kind, path: `${cwd}/${task.file}`, output: `// ${task.file}\n${"export const placeholder = true;\n".repeat(rng.int(3, 40))}` }));
    if (kind === "grep") blocks.push(tool({ kind, pattern: rng.pick(["TODO", "currency", "cursor", "webhook"]), path: "src", output: `src/${rng.pick(["a", "b", "c"])}.ts:${rng.int(1, 200)}: match` }));
    if (kind === "bash") blocks.push(tool({ kind, command: rng.pick(["npm test", "npm run lint", "git status --short", "npm run typecheck"]), isError: rng.chance(0.15), output: rng.chance(0.15) ? "error TS2345: Argument of type 'string' is not assignable" : "ok" }));
    if (kind === "edit") blocks.push(tool({ kind, path: `${cwd}/${task.file}`, oldText: "placeholder = true", newText: "placeholder = false", output: "The file has been updated successfully." }));
  }
  return [
    { t: "prompt", text: task.prompt },
    { t: "response", blocks },
    { t: "response", blocks: [text(`Done — ${task.prompt.toLowerCase().replace(/\.$/, "")}. Tests pass.`)] },
  ];
}

function createTs(line: number): string {
  const pad = Array.from({ length: Math.max(0, line - 12) }, (_, i) => `  // ${i + 11}: validation and customer lookup elided`).join("\n");
  return `import { rates } from "../lib/rates";\nimport { toMinorUnits } from "../lib/money";\nimport type { CreateInvoiceBody } from "./schema";\n\nexport async function createInvoice(body: CreateInvoiceBody, customer: Customer) {\n  const lines = body.lines.map((l) => priceLine(l));\n${pad}\n  const rate = rates[body.currency.toUpperCase()];\n  const total = lines.reduce((sum, l) => sum + l.amount, 0) * rate;\n  return { customerId: customer.id, total: toMinorUnits(total, body.currency) };\n}\n`;
}

function schemaTs(): string {
  return `import { z } from "zod";\n\nexport const createInvoiceBody = z.object({\n  customerId: z.string(),\n  lines: z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })),\n  currency: z.string().length(3),\n});\n\nexport type CreateInvoiceBody = z.infer<typeof createInvoiceBody>;\n`;
}

function currencyTest(): string {
  return `import { describe, expect, it } from "vitest";\nimport { createInvoice } from "./create";\n\ndescribe("currency fallback", () => {\n  it("uses the explicit currency", async () => {\n    expect((await createInvoice(body({ currency: "eur" }), customer("GBP"))).currency).toBe("EUR");\n  });\n  it("falls back to the customer's currency", async () => {\n    expect((await createInvoice(body({}), customer("GBP"))).currency).toBe("GBP");\n  });\n  it("falls back to USD", async () => {\n    expect((await createInvoice(body({}), customer(undefined))).currency).toBe("USD");\n  });\n});\n`;
}

/** A long build log (~30k chars) so full-mode truncation is exercised. */
function bigBuildLog(rng: Rng): string {
  const lines = ["> acme-billing-api@2.3.1 build", "> tsc -p tsconfig.build.json --verbose", ""];
  for (let i = 0; i < 570; i++) {
    lines.push(`[${String(i).padStart(3, "0")}] Building project '/src/${rng.pick(["invoices", "customers", "lib", "webhooks", "reports"])}/${rng.token(8, "abcdefghijklmnopqrstuvwxyz")}.ts'...`);
  }
  lines.push("", "Found 0 errors. Watching for file changes.");
  return lines.join("\n");
}
