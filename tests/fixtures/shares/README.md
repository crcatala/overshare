# Frozen shares

One directory per format, named after it (`overshare-1/` holds `overshare/1` shares), holding real shares
written in that format: the same fake sessions the `overshare fixtures` command generates, redacted and
exported by the code of that day. `agentshare-2/` is the same format as `overshare/1`, written under the
project's earlier name (agent-share) before the rename; the viewer reads it as `overshare/1`.
`tests/viewer-compat.vitest.ts` opens every one in the viewer, in every view and variant, so a
format the viewer says it opens can't quietly stop working.

**Never edit or regenerate a frozen file** — its value is that it was written by the old code.

## When you change the format incompatibly

1. Bump `SCHEMA_VERSION` in `src/schema.ts` (additive changes, like a new optional field, don't need this).
2. Add the migration for the old version in `viewer/src/compat.ts` (`MIGRATIONS`).
3. Freeze a share in the new format, in a new `overshare-<N>/` directory:

   ```sh
   npx tsx src/cli.ts fixtures -o "$(mktemp -d)" --home /home/fixture-user --user fixture-user
   # copy claude-code-{full,brief,minimal,prompts}.json and pi-full.json from its shares/ directory
   ```

The tests fail until 2 and 3 are done. To stop supporting an old format, delete its directory and its
`MIGRATIONS` entry together.
