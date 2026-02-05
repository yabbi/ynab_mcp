import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// =============================================================================
// YNAB API Types
// =============================================================================

interface YNABAccount {
  id: string;
  name: string;
  type: string;
  on_budget: boolean;
  closed: boolean;
  balance: number;
  cleared_balance: number;
  uncleared_balance: number;
}

interface YNABCategory {
  id: string;
  category_group_id: string;
  category_group_name?: string;
  name: string;
  hidden: boolean;
  budgeted: number;
  activity: number;
  balance: number;
  goal_type: string | null;
  goal_target: number | null;
  goal_percentage_complete: number | null;
}

interface YNABCategoryGroup {
  id: string;
  name: string;
  hidden: boolean;
  categories: YNABCategory[];
}

interface YNABPayee {
  id: string;
  name: string;
  transfer_account_id: string | null;
}

interface YNABTransaction {
  id: string;
  date: string;
  amount: number;
  memo: string | null;
  cleared: string;
  approved: boolean;
  account_id: string;
  account_name: string;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
  subtransactions: YNABSubTransaction[];
}

interface YNABSubTransaction {
  id: string;
  amount: number;
  memo: string | null;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
}

interface YNABScheduledTransaction {
  id: string;
  date_first: string;
  date_next: string;
  frequency: string;
  amount: number;
  memo: string | null;
  account_id: string;
  account_name: string;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
}

interface YNABBudget {
  id: string;
  name: string;
}

interface YNABMonth {
  month: string;
  income: number;
  budgeted: number;
  activity: number;
  to_be_budgeted: number;
  age_of_money: number | null;
}

// =============================================================================
// YNAB API Client
// =============================================================================

class YNABClient {
  private baseUrl = "https://api.ynab.com/v1";
  private token: string;
  private budgetId: string | null = null;

  // Cache
  private accounts: YNABAccount[] = [];
  private categories: YNABCategory[] = [];
  private categoryGroups: YNABCategoryGroup[] = [];
  private payees: YNABPayee[] = [];
  private cacheInitialized = false;

  constructor(token: string, budgetId?: string) {
    this.token = token;
    this.budgetId = budgetId || null;
  }

  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      if (response.status === 401) {
        throw new Error("YNAB authentication failed - check your API token");
      }
      if (response.status === 429) {
        throw new Error("YNAB rate limit exceeded - wait a few minutes and try again");
      }
      throw new Error(`YNAB API error: ${error.error?.detail || response.statusText}`);
    }

    return response.json();
  }

  async initialize(): Promise<void> {
    // Get budget ID if not set
    if (!this.budgetId) {
      const { data } = await this.request<{ data: { budgets: YNABBudget[] } }>("/budgets");
      if (data.budgets.length === 0) {
        throw new Error("No budgets found in your YNAB account");
      }
      this.budgetId = data.budgets[0].id;
    }

    // Initialize cache
    await this.refreshCache();
  }

  async refreshCache(): Promise<void> {
    const [accountsRes, categoriesRes, payeesRes] = await Promise.all([
      this.request<{ data: { accounts: YNABAccount[] } }>(`/budgets/${this.budgetId}/accounts`),
      this.request<{ data: { category_groups: YNABCategoryGroup[] } }>(`/budgets/${this.budgetId}/categories`),
      this.request<{ data: { payees: YNABPayee[] } }>(`/budgets/${this.budgetId}/payees`),
    ]);

    this.accounts = accountsRes.data.accounts.filter(a => !a.closed);
    this.categoryGroups = categoriesRes.data.category_groups.filter(g => !g.hidden);
    this.categories = this.categoryGroups.flatMap(g =>
      g.categories.filter(c => !c.hidden).map(c => ({ ...c, category_group_name: g.name }))
    );
    this.payees = payeesRes.data.payees;
    this.cacheInitialized = true;
  }

  // =============================================================================
  // Name Resolution with Fuzzy Matching
  // =============================================================================

  findAccount(query: string): YNABAccount | { matches: YNABAccount[]; error: string } {
    const q = query.toLowerCase();

    // Exact match
    const exact = this.accounts.find(a => a.name.toLowerCase() === q);
    if (exact) return exact;

    // Contains match
    const contains = this.accounts.filter(a => a.name.toLowerCase().includes(q));
    if (contains.length === 1) return contains[0];
    if (contains.length > 1) {
      return { matches: contains, error: `Multiple accounts match "${query}": ${contains.map(a => a.name).join(", ")}` };
    }

    return { matches: [], error: `No account found matching "${query}". Available: ${this.accounts.map(a => a.name).join(", ")}` };
  }

  findCategory(query: string): YNABCategory | { matches: YNABCategory[]; error: string } {
    const q = query.toLowerCase();

    // Exact match
    const exact = this.categories.find(c => c.name.toLowerCase() === q);
    if (exact) return exact;

    // Contains match
    const contains = this.categories.filter(c => c.name.toLowerCase().includes(q));
    if (contains.length === 1) return contains[0];
    if (contains.length > 1) {
      return { matches: contains, error: `Multiple categories match "${query}": ${contains.map(c => `${c.category_group_name}: ${c.name}`).join(", ")}` };
    }

    return { matches: [], error: `No category found matching "${query}". Try one of: ${this.categories.slice(0, 10).map(c => c.name).join(", ")}...` };
  }

  findPayee(query: string): YNABPayee | { matches: YNABPayee[]; isNew: boolean; error?: string } {
    const q = query.toLowerCase();

    // Exact match
    const exact = this.payees.find(p => p.name.toLowerCase() === q);
    if (exact) return exact;

    // Contains/startsWith match
    const matches = this.payees.filter(p =>
      p.name.toLowerCase().includes(q) || p.name.toLowerCase().startsWith(q)
    );

    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      return {
        matches: matches.slice(0, 5),
        isNew: false,
        error: `Multiple payees match "${query}": ${matches.slice(0, 5).map(p => p.name).join(", ")}${matches.length > 5 ? ` (and ${matches.length - 5} more)` : ""}`
      };
    }

    // No match - this would be a new payee
    return { matches: [], isNew: true };
  }

  getAccounts(): YNABAccount[] {
    return this.accounts;
  }

  getCategories(): YNABCategory[] {
    return this.categories;
  }

  getCategoryGroups(): YNABCategoryGroup[] {
    return this.categoryGroups;
  }

  getPayees(): YNABPayee[] {
    return this.payees;
  }

  // =============================================================================
  // API Methods
  // =============================================================================

  async getBudgetSummary(): Promise<{ budget: YNABBudget; month: YNABMonth; accounts: YNABAccount[] }> {
    const [budgetRes, monthRes] = await Promise.all([
      this.request<{ data: { budget: YNABBudget } }>(`/budgets/${this.budgetId}`),
      this.request<{ data: { month: YNABMonth } }>(`/budgets/${this.budgetId}/months/current`),
    ]);

    return {
      budget: budgetRes.data.budget,
      month: monthRes.data.month,
      accounts: this.accounts,
    };
  }

  async getMonthlyBudget(month: string): Promise<YNABMonth> {
    const { data } = await this.request<{ data: { month: YNABMonth } }>(`/budgets/${this.budgetId}/months/${month}`);
    return data.month;
  }

  async getTransactions(options: {
    sinceDate?: string;
    accountId?: string;
    categoryId?: string;
    payeeId?: string;
  } = {}): Promise<YNABTransaction[]> {
    let endpoint = `/budgets/${this.budgetId}/transactions`;

    if (options.accountId) {
      endpoint = `/budgets/${this.budgetId}/accounts/${options.accountId}/transactions`;
    } else if (options.categoryId) {
      endpoint = `/budgets/${this.budgetId}/categories/${options.categoryId}/transactions`;
    } else if (options.payeeId) {
      endpoint = `/budgets/${this.budgetId}/payees/${options.payeeId}/transactions`;
    }

    const params = new URLSearchParams();
    if (options.sinceDate) params.set("since_date", options.sinceDate);

    const query = params.toString();
    const { data } = await this.request<{ data: { transactions: YNABTransaction[] } }>(
      `${endpoint}${query ? `?${query}` : ""}`
    );

    return data.transactions;
  }

  async getScheduledTransactions(): Promise<YNABScheduledTransaction[]> {
    const { data } = await this.request<{ data: { scheduled_transactions: YNABScheduledTransaction[] } }>(
      `/budgets/${this.budgetId}/scheduled_transactions`
    );
    return data.scheduled_transactions;
  }

  async createTransaction(transaction: {
    account_id: string;
    date: string;
    amount: number;
    payee_name?: string;
    payee_id?: string;
    category_id?: string;
    memo?: string;
    cleared?: string;
  }): Promise<YNABTransaction> {
    const { data } = await this.request<{ data: { transaction: YNABTransaction } }>(
      `/budgets/${this.budgetId}/transactions`,
      {
        method: "POST",
        body: JSON.stringify({ transaction }),
      }
    );

    // Refresh payee cache if we created a new one
    if (transaction.payee_name && !transaction.payee_id) {
      await this.refreshCache();
    }

    return data.transaction;
  }

  async createScheduledTransaction(transaction: {
    account_id: string;
    date_first: string;
    frequency: string;
    amount: number;
    payee_name?: string;
    payee_id?: string;
    category_id?: string;
    memo?: string;
  }): Promise<YNABScheduledTransaction> {
    const { data } = await this.request<{ data: { scheduled_transaction: YNABScheduledTransaction } }>(
      `/budgets/${this.budgetId}/scheduled_transactions`,
      {
        method: "POST",
        body: JSON.stringify({ scheduled_transaction: transaction }),
      }
    );
    return data.scheduled_transaction;
  }

  async deleteTransaction(transactionId: string): Promise<void> {
    await this.request(`/budgets/${this.budgetId}/transactions/${transactionId}`, {
      method: "DELETE",
    });
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

function milliunitsToUSD(milliunits: number): number {
  return milliunits / 1000;
}

function usdToMilliunits(usd: number): number {
  return Math.round(usd * 1000);
}

function formatUSD(milliunits: number): string {
  const usd = milliunitsToUSD(milliunits);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(usd);
}

function parseDate(input: string): string {
  const lower = input.toLowerCase();
  const today = new Date();

  if (lower === "today") {
    return today.toISOString().split("T")[0];
  }
  if (lower === "yesterday") {
    today.setDate(today.getDate() - 1);
    return today.toISOString().split("T")[0];
  }
  if (lower === "tomorrow") {
    today.setDate(today.getDate() + 1);
    return today.toISOString().split("T")[0];
  }

  // Try to parse as date
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split("T")[0];
  }

  throw new Error(`Could not parse date: "${input}". Try formats like "today", "yesterday", "2024-01-15"`);
}

// =============================================================================
// MCP Server
// =============================================================================

const server = new McpServer({
  name: "ynab",
  version: "1.0.0",
});

let client: YNABClient;

// Initialize client
async function initializeClient(): Promise<void> {
  const token = process.env.YNAB_API_TOKEN;
  if (!token) {
    throw new Error("YNAB_API_TOKEN environment variable is required");
  }

  client = new YNABClient(token, process.env.YNAB_BUDGET_ID);
  await client.initialize();
}

// =============================================================================
// Read Tools
// =============================================================================

server.tool(
  "get_budget_summary",
  "Get an overview of your YNAB budget including ready to assign amount, total budgeted, activity, and account balances",
  {},
  async () => {
    const summary = await client.getBudgetSummary();

    const accountsList = summary.accounts
      .map(a => `  ${a.name}: ${formatUSD(a.balance)}`)
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: `Budget: ${summary.budget.name}

Ready to Assign: ${formatUSD(summary.month.to_be_budgeted)}
Total Budgeted: ${formatUSD(summary.month.budgeted)}
Total Activity: ${formatUSD(summary.month.activity)}
Income: ${formatUSD(summary.month.income)}
Age of Money: ${summary.month.age_of_money ?? "N/A"} days

Accounts:
${accountsList}`,
        },
      ],
    };
  }
);

server.tool(
  "get_accounts",
  "List all your YNAB accounts with their current balances",
  {},
  async () => {
    const accounts = client.getAccounts();

    const list = accounts
      .map(a => `${a.name} (${a.type}): ${formatUSD(a.balance)} (cleared: ${formatUSD(a.cleared_balance)}, uncleared: ${formatUSD(a.uncleared_balance)})`)
      .join("\n");

    return {
      content: [{ type: "text", text: `Accounts:\n${list}` }],
    };
  }
);

server.tool(
  "get_categories",
  "List all budget categories with their budgeted, spent, and available amounts",
  {},
  async () => {
    const groups = client.getCategoryGroups();

    const output = groups.map(g => {
      const cats = g.categories
        .filter(c => !c.hidden)
        .map(c => `    ${c.name}: Budgeted ${formatUSD(c.budgeted)} | Spent ${formatUSD(c.activity)} | Available ${formatUSD(c.balance)}`)
        .join("\n");
      return `${g.name}:\n${cats}`;
    }).join("\n\n");

    return {
      content: [{ type: "text", text: output }],
    };
  }
);

server.tool(
  "get_category",
  "Get details for a specific budget category by name",
  {
    name: z.string().describe("Category name to look up (e.g., 'Groceries', 'Rent')"),
  },
  async ({ name }) => {
    const result = client.findCategory(name);

    if ("error" in result) {
      return {
        content: [{ type: "text", text: result.error }],
        isError: true,
      };
    }

    const c = result;
    let output = `Category: ${c.category_group_name}: ${c.name}
Budgeted: ${formatUSD(c.budgeted)}
Activity (Spent): ${formatUSD(c.activity)}
Available: ${formatUSD(c.balance)}`;

    if (c.goal_type) {
      output += `\n\nGoal: ${c.goal_type}`;
      if (c.goal_target) output += ` - Target: ${formatUSD(c.goal_target)}`;
      if (c.goal_percentage_complete !== null) output += ` (${c.goal_percentage_complete}% complete)`;
    }

    return {
      content: [{ type: "text", text: output }],
    };
  }
);

server.tool(
  "get_transactions",
  "Get recent transactions, optionally filtered by account, category, payee, or date",
  {
    since_date: z.string().optional().describe("Only show transactions on or after this date (e.g., 'today', 'yesterday', '2024-01-01')"),
    account: z.string().optional().describe("Filter by account name"),
    category: z.string().optional().describe("Filter by category name"),
    payee: z.string().optional().describe("Filter by payee name"),
    limit: z.number().optional().describe("Maximum number of transactions to return (default 20)"),
  },
  async ({ since_date, account, category, payee, limit = 20 }) => {
    const options: { sinceDate?: string; accountId?: string; categoryId?: string; payeeId?: string } = {};

    if (since_date) {
      options.sinceDate = parseDate(since_date);
    }

    if (account) {
      const result = client.findAccount(account);
      if ("error" in result) {
        return { content: [{ type: "text", text: result.error }], isError: true };
      }
      options.accountId = result.id;
    }

    if (category) {
      const result = client.findCategory(category);
      if ("error" in result) {
        return { content: [{ type: "text", text: result.error }], isError: true };
      }
      options.categoryId = result.id;
    }

    if (payee) {
      const result = client.findPayee(payee);
      if ("id" in result) {
        options.payeeId = result.id;
      } else if (result.matches.length > 0) {
        return { content: [{ type: "text", text: result.error! }], isError: true };
      }
      // If no matches, we'll just return all transactions (payee doesn't exist)
    }

    const transactions = await client.getTransactions(options);
    const limited = transactions.slice(0, limit);

    if (limited.length === 0) {
      return { content: [{ type: "text", text: "No transactions found matching your criteria." }] };
    }

    const list = limited.map(t => {
      const amount = formatUSD(t.amount);
      const type = t.amount < 0 ? "outflow" : "inflow";
      return `${t.date} | ${amount} (${type}) | ${t.payee_name || "No payee"} | ${t.category_name || "Uncategorized"} | ${t.account_name}${t.memo ? ` | "${t.memo}"` : ""}`;
    }).join("\n");

    return {
      content: [{ type: "text", text: `Transactions (${limited.length}${transactions.length > limit ? ` of ${transactions.length}` : ""}):\n${list}` }],
    };
  }
);

server.tool(
  "get_payees",
  "List all payees in your budget",
  {},
  async () => {
    const payees = client.getPayees()
      .filter(p => !p.transfer_account_id) // Exclude transfer payees
      .slice(0, 50);

    const list = payees.map(p => p.name).join(", ");
    return {
      content: [{ type: "text", text: `Payees (showing up to 50):\n${list}` }],
    };
  }
);

server.tool(
  "get_monthly_budget",
  "Get budget summary for a specific month",
  {
    month: z.string().describe("Month in YYYY-MM-DD format (day is ignored) or 'current' for this month"),
  },
  async ({ month }) => {
    const monthStr = month === "current" ? "current" : parseDate(month).slice(0, 7) + "-01";
    const data = await client.getMonthlyBudget(monthStr);

    return {
      content: [{
        type: "text",
        text: `Month: ${data.month}
Income: ${formatUSD(data.income)}
Budgeted: ${formatUSD(data.budgeted)}
Activity: ${formatUSD(data.activity)}
To Be Budgeted: ${formatUSD(data.to_be_budgeted)}
Age of Money: ${data.age_of_money ?? "N/A"} days`,
      }],
    };
  }
);

// =============================================================================
// Write Tools
// =============================================================================

server.tool(
  "create_transaction",
  "Create a new transaction in YNAB. Amounts should be positive for inflows (income) and negative for outflows (spending).",
  {
    amount: z.number().describe("Amount in dollars. Use negative for spending (outflows), positive for income (inflows). Example: -50.00 for a $50 purchase"),
    payee: z.string().describe("Payee name. Will fuzzy-match existing payees or create a new one"),
    category: z.string().optional().describe("Category name (e.g., 'Groceries'). Optional for inflows"),
    account: z.string().optional().describe("Account name. Defaults to first account if not specified"),
    date: z.string().optional().describe("Transaction date. Defaults to today. Accepts 'today', 'yesterday', or YYYY-MM-DD"),
    memo: z.string().optional().describe("Optional memo/note for the transaction"),
    confirm_new_payee: z.boolean().optional().describe("Set to true to confirm creating a new payee that doesn't exist yet"),
  },
  async ({ amount, payee, category, account, date, memo, confirm_new_payee }) => {
    // Resolve account
    let accountId: string;
    if (account) {
      const result = client.findAccount(account);
      if ("error" in result) {
        return { content: [{ type: "text", text: result.error }], isError: true };
      }
      accountId = result.id;
    } else {
      const accounts = client.getAccounts();
      if (accounts.length === 0) {
        return { content: [{ type: "text", text: "No accounts found in your budget" }], isError: true };
      }
      accountId = accounts[0].id;
    }

    // Resolve payee
    const payeeResult = client.findPayee(payee);
    let payeeId: string | undefined;
    let payeeName: string | undefined;

    if ("id" in payeeResult) {
      // Exact or single match found
      payeeId = payeeResult.id;
    } else if (payeeResult.matches.length > 0) {
      // Multiple matches - ask for clarification
      return {
        content: [{
          type: "text",
          text: `Multiple payees match "${payee}":\n${payeeResult.matches.map(p => `  - ${p.name}`).join("\n")}\n\nPlease specify which payee you mean, or use the exact name.`,
        }],
        isError: true,
      };
    } else if (payeeResult.isNew) {
      // New payee - require confirmation
      if (!confirm_new_payee) {
        return {
          content: [{
            type: "text",
            text: `"${payee}" is a new payee that doesn't exist in your budget yet. To create this transaction with a new payee, set confirm_new_payee to true.`,
          }],
          isError: true,
        };
      }
      payeeName = payee;
    }

    // Resolve category
    let categoryId: string | undefined;
    if (category) {
      const result = client.findCategory(category);
      if ("error" in result) {
        return { content: [{ type: "text", text: result.error }], isError: true };
      }
      categoryId = result.id;
    }

    // Parse date
    const transactionDate = date ? parseDate(date) : new Date().toISOString().split("T")[0];

    // Create transaction
    const transaction = await client.createTransaction({
      account_id: accountId,
      date: transactionDate,
      amount: usdToMilliunits(amount),
      payee_id: payeeId,
      payee_name: payeeName,
      category_id: categoryId,
      memo,
      cleared: "uncleared",
    });

    return {
      content: [{
        type: "text",
        text: `Transaction created successfully:
Date: ${transaction.date}
Amount: ${formatUSD(transaction.amount)}
Payee: ${transaction.payee_name}
Category: ${transaction.category_name || "Uncategorized"}
Account: ${transaction.account_name}
${transaction.memo ? `Memo: ${transaction.memo}` : ""}
ID: ${transaction.id}`,
      }],
    };
  }
);

server.tool(
  "create_scheduled_transaction",
  "Create a recurring scheduled transaction",
  {
    amount: z.number().describe("Amount in dollars. Use negative for spending, positive for income"),
    payee: z.string().describe("Payee name"),
    frequency: z.enum(["daily", "weekly", "everyOtherWeek", "twiceAMonth", "every4Weeks", "monthly", "everyOtherMonth", "every3Months", "every4Months", "twiceAYear", "yearly", "everyOtherYear"]).describe("How often the transaction repeats"),
    start_date: z.string().describe("First occurrence date (e.g., 'tomorrow', '2024-02-01')"),
    category: z.string().optional().describe("Category name"),
    account: z.string().optional().describe("Account name"),
    memo: z.string().optional().describe("Optional memo"),
    confirm_new_payee: z.boolean().optional().describe("Set to true to confirm creating a new payee"),
  },
  async ({ amount, payee, frequency, start_date, category, account, memo, confirm_new_payee }) => {
    // Resolve account
    let accountId: string;
    if (account) {
      const result = client.findAccount(account);
      if ("error" in result) {
        return { content: [{ type: "text", text: result.error }], isError: true };
      }
      accountId = result.id;
    } else {
      const accounts = client.getAccounts();
      accountId = accounts[0].id;
    }

    // Resolve payee
    const payeeResult = client.findPayee(payee);
    let payeeId: string | undefined;
    let payeeName: string | undefined;

    if ("id" in payeeResult) {
      payeeId = payeeResult.id;
    } else if (payeeResult.matches.length > 0) {
      return {
        content: [{
          type: "text",
          text: `Multiple payees match "${payee}":\n${payeeResult.matches.map(p => `  - ${p.name}`).join("\n")}\n\nPlease specify which payee you mean.`,
        }],
        isError: true,
      };
    } else if (payeeResult.isNew && !confirm_new_payee) {
      return {
        content: [{
          type: "text",
          text: `"${payee}" is a new payee. Set confirm_new_payee to true to create it.`,
        }],
        isError: true,
      };
    } else {
      payeeName = payee;
    }

    // Resolve category
    let categoryId: string | undefined;
    if (category) {
      const result = client.findCategory(category);
      if ("error" in result) {
        return { content: [{ type: "text", text: result.error }], isError: true };
      }
      categoryId = result.id;
    }

    const transaction = await client.createScheduledTransaction({
      account_id: accountId,
      date_first: parseDate(start_date),
      frequency,
      amount: usdToMilliunits(amount),
      payee_id: payeeId,
      payee_name: payeeName,
      category_id: categoryId,
      memo,
    });

    return {
      content: [{
        type: "text",
        text: `Scheduled transaction created:
First Date: ${transaction.date_first}
Next Date: ${transaction.date_next}
Frequency: ${transaction.frequency}
Amount: ${formatUSD(transaction.amount)}
Payee: ${transaction.payee_name}
Category: ${transaction.category_name || "Uncategorized"}
Account: ${transaction.account_name}`,
      }],
    };
  }
);

// =============================================================================
// Delete Tool
// =============================================================================

server.tool(
  "delete_transaction",
  "⚠️ PERMANENTLY delete a transaction from YNAB. This cannot be undone. Only use this if you're certain you want to remove the transaction.",
  {
    transaction_id: z.string().describe("The transaction ID to delete. Get this from get_transactions"),
  },
  async ({ transaction_id }) => {
    await client.deleteTransaction(transaction_id);
    return {
      content: [{ type: "text", text: `Transaction ${transaction_id} has been permanently deleted.` }],
    };
  }
);

// =============================================================================
// Start Server
// =============================================================================

async function main() {
  try {
    await initializeClient();

    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    console.error("Failed to start YNAB MCP server:", error);
    process.exit(1);
  }
}

main();
