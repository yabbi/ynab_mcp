# YNAB MCP Server

An MCP (Model Context Protocol) server that enables AI assistants to interact with your YNAB budget through natural conversation. Works with Claude, GitHub Copilot, OpenAI Codex, and any MCP-compatible client.

## Features

- **Read your budget**: View budget summary, accounts, categories, transactions, payees, scheduled transactions
- **Manage transactions**: Create, update, and delete transactions with split transaction support
- **Budgeting**: Set category budgets, update categories, view month-by-month breakdowns
- **Account management**: Create accounts, view details, reconcile balances
- **Scheduled transactions**: Create and view recurring transactions
- **Payee management**: View and rename payees
- **Human-friendly inputs**: Use category/account/payee names (not IDs), dollar amounts, flexible dates
- **Smart payee matching**: Fuzzy matches existing payees with confirmation for new ones
- **Full goal details**: View all goal information including targets, progress, and funding status

## Setup

### 1. Get Your YNAB API Token

1. Go to [YNAB](https://app.ynab.com) → Account Settings → Developer Settings
2. Create a new Personal Access Token
3. Copy the token

### 2. Install Dependencies

```bash
npm install
npm run build
```

### 3. Configure Your MCP Client

#### Claude Code

Add to `~/.claude/mcp_servers.json`:

```json
{
  "ynab": {
    "command": "node",
    "args": ["/path/to/ynab-mcp/dist/index.js"],
    "env": {
      "YNAB_API_TOKEN": "your-token-here"
    }
  }
}
```

#### GitHub Copilot

Add to your VS Code `settings.json`:

```json
{
  "github.copilot.chat.mcpServers": {
    "ynab": {
      "command": "node",
      "args": ["/path/to/ynab-mcp/dist/index.js"],
      "env": {
        "YNAB_API_TOKEN": "your-token-here"
      }
    }
  }
}
```

#### OpenAI Codex / Other MCP Clients

Use the stdio transport with the following command:

```bash
YNAB_API_TOKEN=your-token-here node /path/to/ynab-mcp/dist/index.js
```

Or configure in your client's MCP settings with:
- **Command**: `node`
- **Args**: `["/path/to/ynab-mcp/dist/index.js"]`
- **Environment**: `YNAB_API_TOKEN=your-token-here`

Replace `/path/to/ynab-mcp` with the actual path to this directory.

## Available Tools

### Discovery

| Tool | Description |
|------|-------------|
| `search_tools` | Search available YNAB tools by keyword or category (budget, accounts, categories, transactions, scheduled, payees) |

### Budget

| Tool | Description |
|------|-------------|
| `get_budget_summary` | Overview: ready to assign, budgeted, activity, account balances |
| `get_monthly_budget` | Budget summary for a specific month |
| `get_budget_months` | List all budget months with budgeted, activity, and to-be-budgeted amounts |

### Accounts

| Tool | Description |
|------|-------------|
| `get_accounts` | List all accounts with balances (cleared/uncleared) |
| `get_account` | Detailed info for a single account by name |
| `create_account` | Create a new account (checking, savings, credit card, etc.) |
| `reconcile_account` | Reconcile an account with optional balance adjustment |

### Categories

| Tool | Description |
|------|-------------|
| `get_categories` | All categories with budgeted/spent/available amounts |
| `get_category` | Details for a specific category including full goal information |
| `get_month_category` | Category details for a specific month (budgeted, activity, balance, goals) |
| `set_category_budget` | Set the budgeted amount for a category in a specific month |
| `update_category` | Update a category's name, note, or goal target |

### Transactions

| Tool | Description |
|------|-------------|
| `get_transactions` | Recent transactions with filters (account, category, payee, date) |
| `get_transaction` | Get a single transaction by ID |
| `get_month_transactions` | All transactions for a specific budget month |
| `create_transaction` | Add a new transaction with smart payee matching and split support |
| `update_transaction` | Update an existing transaction (amount, payee, category, cleared status, etc.) |
| `delete_transaction` | Permanently delete a transaction by ID |

### Scheduled Transactions

| Tool | Description |
|------|-------------|
| `get_scheduled_transactions` | List all scheduled (recurring) transactions |
| `create_scheduled_transaction` | Create a recurring transaction |

### Payees

| Tool | Description |
|------|-------------|
| `get_payees` | List all payees |
| `get_payee` | Get details for a single payee by name |
| `update_payee` | Rename a payee |

## Data Shown

### Transactions
Each transaction displays:
- Date
- Amount (with inflow/outflow indicator)
- Cleared status (cleared/uncleared/reconciled)
- Approval status (approved/pending)
- Payee, Category, Account
- Memo (if present)

### Categories with Goals
When a category has a goal, you'll see:
- Goal type (TB, TBD, MF, NEED, DEBT)
- Target amount
- Target month
- Progress percentage
- Total funded and remaining
- Under-funded amount (if any)
- Months to budget
- Goal creation date

## Usage Examples

**Check your budget:**
> "What's my budget looking like?"

**View spending:**
> "How much have I spent on groceries this month?"

**Add a transaction:**
> "I spent $45 at Whole Foods for groceries"

**Split transaction:**
> "I spent $100 at Costco — $60 on groceries and $40 on household supplies"

**Update a transaction:**
> "Mark my last Whole Foods transaction as cleared"

**Set a category budget:**
> "Budget $500 for groceries this month"

**Check account balances:**
> "What are my account balances?"

**Reconcile an account:**
> "Reconcile my checking account to $1,234.56"

**View category goal progress:**
> "How am I doing on my vacation savings goal?"

## Smart Features

### Payee Matching
- Fuzzy matches existing payees ("Amazon" finds "Amazon.com")
- Asks for clarification when multiple matches exist
- Confirms before creating new payees

### Flexible Dates
- "today", "yesterday", "tomorrow"
- YYYY-MM-DD format

### Dollar Amounts
- Enter amounts in dollars (e.g., -50.00)
- Negative = spending, Positive = income
- Automatically converted to YNAB's milliunits

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `YNAB_API_TOKEN` | Yes | Your YNAB Personal Access Token |
| `YNAB_BUDGET_ID` | No | Override auto-detected budget |

## Rate Limits

YNAB API allows 200 requests per hour. The server fetches fresh data for each request to ensure accuracy.

## License

ISC
