# YNAB MCP Server

## Architecture

Single-file MCP server (`src/index.ts`) that wraps the YNAB API. Uses `@modelcontextprotocol/sdk` with stdio transport. All tools are registered on a single `McpServer` instance.

## Key Conventions

- Tool names use `snake_case` (e.g., `get_budget_summary`, `create_transaction`)
- Amounts are in dollars at the tool interface, converted to YNAB milliunits internally via `usdToMilliunits()`
- Name resolution (accounts, categories, payees) uses fuzzy matching with `find*` methods
- Payees are cached; accounts and categories are fetched fresh each call

## Important: Keep TOOL_CATALOG and README in sync

When adding, removing, or renaming tools, or updating their descriptions, you must update **both**:

1. **`TOOL_CATALOG`** in `src/index.ts` — the static array used by `search_tools`. Categories: `budget`, `accounts`, `categories`, `transactions`, `scheduled`, `payees`.
2. **`README.md`** — the "Available Tools" section with the tool tables organized by category.

## Build

```bash
npm run build
```

Compiles TypeScript to `dist/index.js`.
