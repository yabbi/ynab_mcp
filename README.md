# YNAB MCP Server

An MCP (Model Context Protocol) server that enables AI assistants to interact with your YNAB budget through natural conversation. Works with Claude, GitHub Copilot, OpenAI Codex, and any MCP-compatible client.

## Features

- **Read your budget**: View budget summary, accounts, categories, transactions, payees
- **Create transactions**: Add new transactions with smart payee matching
- **Create scheduled transactions**: Set up recurring transactions
- **Delete transactions**: Remove transactions (with confirmation)
- **Human-friendly inputs**: Use category/account/payee names (not IDs), dollar amounts, flexible dates
- **Transaction status**: Shows cleared/uncleared/reconciled and approval status
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

### Read Tools

| Tool | Description |
|------|-------------|
| `get_budget_summary` | Overview: ready to assign, budgeted, activity, account balances |
| `get_accounts` | List all accounts with balances (cleared/uncleared) |
| `get_categories` | All categories with budgeted/spent/available amounts |
| `get_category` | Details for a specific category including full goal information |
| `get_transactions` | Recent transactions with cleared/approved status and optional filters |
| `get_payees` | List all payees |
| `get_monthly_budget` | Budget summary for a specific month |

### Write Tools

| Tool | Description |
|------|-------------|
| `create_transaction` | Add a new transaction with smart payee matching |
| `create_scheduled_transaction` | Create a recurring transaction |

### Delete Tools

| Tool | Description |
|------|-------------|
| `delete_transaction` | Permanently delete a transaction by ID |

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

**Check account balances:**
> "What are my account balances?"

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
