---
name: DB push interactive prompt
description: drizzle-kit push requires interactive TTY; workaround for non-interactive environments
---

# Rule
`pnpm --filter @workspace/db run push` requires a TTY for interactive table rename/create confirmation. In the agent environment, it hangs and never completes when a new table could be confused for a rename of an existing one.

**Why:** drizzle-kit uses inquirer-style prompts that require a real TTY. Piping `\n` or `y` doesn't work because it's an arrow-key selection prompt.

# How to apply
When adding a new table, use `executeSql` in the code_execution tool to directly run the `CREATE TABLE IF NOT EXISTS` DDL statement. Copy the column definitions from the Drizzle schema file to write the raw SQL.

Example:
```javascript
const result = await executeSql({ sqlQuery: `CREATE TABLE IF NOT EXISTS "announcements" (...)` });
```

After the table exists, drizzle push will no longer prompt (it detects no changes needed).
