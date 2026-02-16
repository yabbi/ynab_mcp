# YNAB MCP Server

## Architecture

MCP server wrapping the YNAB API. Uses `@modelcontextprotocol/sdk` with stdio transport.

```
src/
  index.ts           Entry point: create server, init client, register tools, start
  types.ts           TypeScript interfaces (YNABAccount, YNABTransaction, etc.)
  client.ts          YNABClient class (HTTP, caching, fuzzy matching, API methods)
  utils.ts           milliunitsToUSD, usdToMilliunits, formatUSD, parseDate
  tools/
    catalog.ts       TOOL_CATALOG array + search_tools registration
    budget.ts        get_budget_summary, get_monthly_budget, get_budget_months
    accounts.ts      get_accounts, get_account, create_account, reconcile_account
    categories.ts    get_categories, get_category, get_month_category, set_category_budget, update_category
    transactions.ts  get_transactions, get_transaction, get_month_transactions, create_transaction, update_transaction, delete_transaction
    scheduled.ts     get_scheduled_transactions, create_scheduled_transaction
    payees.ts        get_payees, get_payee, update_payee
```

Each tool file exports a `register*Tools(server, client)` function called from `index.ts`.

## Key Conventions

- Tool names use `snake_case` (e.g., `get_budget_summary`, `create_transaction`)
- Amounts are in dollars at the tool interface, converted to YNAB milliunits internally via `usdToMilliunits()`
- Name resolution (accounts, categories, payees) uses fuzzy matching with `find*` methods
- Payees are cached; accounts and categories are fetched fresh each call

## Important: Keep TOOL_CATALOG and README in sync

When adding, removing, or renaming tools, or updating their descriptions, you must update **both**:

1. **`TOOL_CATALOG`** in `src/tools/catalog.ts` — the static array used by `search_tools`. Categories: `budget`, `accounts`, `categories`, `transactions`, `scheduled`, `payees`.
2. **`README.md`** — the "Available Tools" section with the tool tables organized by category.

## Build

```bash
npm run build
```

Compiles TypeScript to `dist/index.js`.
