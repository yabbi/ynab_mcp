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
  goal_needs_whole_amount: boolean | null;
  goal_day: number | null;
  goal_cadence: number | null;
  goal_cadence_frequency: number | null;
  goal_creation_month: string | null;
  goal_target_month: string | null;
  goal_months_to_budget: number | null;
  goal_under_funded: number | null;
  goal_overall_funded: number | null;
  goal_overall_left: number | null;
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

  // Cache - only for name resolution (IDs), not balances
  private payees: YNABPayee[] = [];
  private cacheInitialized = false;
  private lastCacheRefresh: Date | null = null;

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
    // Only cache payees for name resolution - they rarely change
    // Accounts and categories are fetched fresh each time to get current balances
    const payeesRes = await this.request<{ data: { payees: YNABPayee[] } }>(`/budgets/${this.budgetId}/payees`);
    this.payees = payeesRes.data.payees;
    this.cacheInitialized = true;
    this.lastCacheRefresh = new Date();
  }

  // Fetch fresh account data (not cached - balances change frequently)
  async getAccountsFresh(): Promise<YNABAccount[]> {
    const { data } = await this.request<{ data: { accounts: YNABAccount[] } }>(`/budgets/${this.budgetId}/accounts`);
    return data.accounts.filter(a => !a.closed);
  }

  // Fetch fresh category data (not cached - balances change frequently)
  async getCategoriesFresh(): Promise<{ groups: YNABCategoryGroup[]; categories: YNABCategory[] }> {
    const { data } = await this.request<{ data: { category_groups: YNABCategoryGroup[] } }>(`/budgets/${this.budgetId}/categories`);
    const groups = data.category_groups.filter(g => !g.hidden);
    const categories = groups.flatMap(g =>
      g.categories.filter(c => !c.hidden).map(c => ({ ...c, category_group_name: g.name }))
    );
    return { groups, categories };
  }

  // =============================================================================
  // Name Resolution with Fuzzy Matching (fetches fresh data)
  // =============================================================================

  async findAccount(query: string): Promise<YNABAccount | { matches: YNABAccount[]; error: string }> {
    const accounts = await this.getAccountsFresh();
    const q = query.toLowerCase();

    // Exact match
    const exact = accounts.find(a => a.name.toLowerCase() === q);
    if (exact) return exact;

    // Contains match
    const contains = accounts.filter(a => a.name.toLowerCase().includes(q));
    if (contains.length === 1) return contains[0];
    if (contains.length > 1) {
      return { matches: contains, error: `Multiple accounts match "${query}": ${contains.map(a => a.name).join(", ")}` };
    }

    return { matches: [], error: `No account found matching "${query}". Available: ${accounts.map(a => a.name).join(", ")}` };
  }

  async findCategory(query: string): Promise<YNABCategory | { matches: YNABCategory[]; error: string }> {
    const { categories } = await this.getCategoriesFresh();
    const q = query.toLowerCase();

    // Exact match
    const exact = categories.find(c => c.name.toLowerCase() === q);
    if (exact) return exact;

    // Contains match
    const contains = categories.filter(c => c.name.toLowerCase().includes(q));
    if (contains.length === 1) return contains[0];
    if (contains.length > 1) {
      return { matches: contains, error: `Multiple categories match "${query}": ${contains.map(c => `${c.category_group_name}: ${c.name}`).join(", ")}` };
    }

    return { matches: [], error: `No category found matching "${query}". Try one of: ${categories.slice(0, 10).map(c => c.name).join(", ")}...` };
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

  getPayees(): YNABPayee[] {
    return this.payees;
  }

  // =============================================================================
  // API Methods
  // =============================================================================

  async getBudgetSummary(): Promise<{ budget: YNABBudget; month: YNABMonth; accounts: YNABAccount[] }> {
    const [budgetRes, monthRes, accounts] = await Promise.all([
      this.request<{ data: { budget: YNABBudget } }>(`/budgets/${this.budgetId}`),
      this.request<{ data: { month: YNABMonth } }>(`/budgets/${this.budgetId}/months/current`),
      this.getAccountsFresh(),
    ]);

    return {
      budget: budgetRes.data.budget,
      month: monthRes.data.month,
      accounts,
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
    limit?: number;
  } = {}): Promise<YNABTransaction[]> {
    let endpoint = `/budgets/${this.budgetId}/transactions`;

    if (options.accountId) {
      endpoint = `/budgets/${this.budgetId}/accounts/${options.accountId}/transactions`;
    } else if (options.categoryId) {
      endpoint = `/budgets/${this.budgetId}/categories/${options.categoryId}/transactions`;
    } else if (options.payeeId) {
      endpoint = `/budgets/${this.budgetId}/payees/${options.payeeId}/transactions`;
    }

    const limit = options.limit ?? 20;

    // YNAB API returns transactions in ascending date order with no sort option.
    // When no since_date is provided, use an expanding window strategy to fetch
    // only recent transactions instead of the entire history.
    if (!options.sinceDate) {
      const windowDays = [30, 90, 180, 365];
      for (const days of windowDays) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        const sinceStr = since.toISOString().split("T")[0];

        const params = new URLSearchParams();
        params.set("since_date", sinceStr);
        const query = params.toString();

        const { data } = await this.request<{ data: { transactions: YNABTransaction[] } }>(
          `${endpoint}?${query}`
        );

        if (data.transactions.length >= limit) {
          // Sort descending (most recent first) and return
          return data.transactions.sort((a, b) => b.date.localeCompare(a.date));
        }

        // If the smallest window already returned fewer than limit,
        // and we haven't exhausted all windows, keep expanding
      }

      // Fallback: fetch all transactions (no since_date filter)
    }

    const params = new URLSearchParams();
    if (options.sinceDate) params.set("since_date", options.sinceDate);

    const query = params.toString();
    const { data } = await this.request<{ data: { transactions: YNABTransaction[] } }>(
      `${endpoint}${query ? `?${query}` : ""}`
    );

    // Sort descending (most recent first)
    return data.transactions.sort((a, b) => b.date.localeCompare(a.date));
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

  async updateTransaction(transactionId: string, updates: {
    amount?: number;
    date?: string;
    payee_name?: string;
    payee_id?: string;
    category_id?: string;
    memo?: string;
    cleared?: string;
  }): Promise<YNABTransaction> {
    const { data } = await this.request<{ data: { transaction: YNABTransaction } }>(
      `/budgets/${this.budgetId}/transactions/${transactionId}`,
      {
        method: "PUT",
        body: JSON.stringify({ transaction: updates }),
      }
    );

    if (updates.payee_name && !updates.payee_id) {
      await this.refreshCache();
    }

    return data.transaction;
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
    const accounts = await client.getAccountsFresh();

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
    const { groups } = await client.getCategoriesFresh();

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
    const result = await client.findCategory(name);

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
      if (c.goal_target) output += `\n  Target: ${formatUSD(c.goal_target)}`;
      if (c.goal_target_month) output += `\n  Target Month: ${c.goal_target_month}`;
      if (c.goal_percentage_complete !== null) output += `\n  Progress: ${c.goal_percentage_complete}% complete`;
      if (c.goal_overall_funded !== null) output += `\n  Funded: ${formatUSD(c.goal_overall_funded)}`;
      if (c.goal_overall_left !== null) output += `\n  Remaining: ${formatUSD(c.goal_overall_left)}`;
      if (c.goal_under_funded !== null && c.goal_under_funded !== 0) output += `\n  Under-funded: ${formatUSD(c.goal_under_funded)}`;
      if (c.goal_months_to_budget !== null) output += `\n  Months to Budget: ${c.goal_months_to_budget}`;
      if (c.goal_creation_month) output += `\n  Created: ${c.goal_creation_month}`;
    }

    return {
      content: [{ type: "text", text: output }],
    };
  }
);

server.tool(
  "get_transactions",
  "Get transactions sorted by most recent first, optionally filtered by account, category, payee, or date",
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
      const result = await client.findAccount(account);
      if ("error" in result) {
        return { content: [{ type: "text" as const, text: result.error }], isError: true };
      }
      options.accountId = result.id;
    }

    if (category) {
      const result = await client.findCategory(category);
      if ("error" in result) {
        return { content: [{ type: "text" as const, text: result.error }], isError: true };
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

    const transactions = await client.getTransactions({ ...options, limit });
    const limited = transactions.slice(0, limit);

    if (limited.length === 0) {
      return { content: [{ type: "text", text: "No transactions found matching your criteria." }] };
    }

    const list = limited.map(t => {
      const amount = formatUSD(t.amount);
      const type = t.amount < 0 ? "outflow" : "inflow";
      const approvalStatus = t.approved ? "approved" : "pending";
      return `[${t.id}] ${t.date} | ${amount} (${type}) | ${t.cleared} | ${approvalStatus} | ${t.payee_name || "No payee"} | ${t.category_name || "Uncategorized"} | ${t.account_name}${t.memo ? ` | "${t.memo}"` : ""}`;
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
      const result = await client.findAccount(account);
      if ("error" in result) {
        return { content: [{ type: "text" as const, text: result.error }], isError: true };
      }
      accountId = result.id;
    } else {
      const accounts = await client.getAccountsFresh();
      if (accounts.length === 0) {
        return { content: [{ type: "text" as const, text: "No accounts found in your budget" }], isError: true };
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
          type: "text" as const,
          text: `Multiple payees match "${payee}":\n${payeeResult.matches.map(p => `  - ${p.name}`).join("\n")}\n\nPlease specify which payee you mean, or use the exact name.`,
        }],
        isError: true,
      };
    } else if (payeeResult.isNew) {
      // New payee - require confirmation
      if (!confirm_new_payee) {
        return {
          content: [{
            type: "text" as const,
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
      const result = await client.findCategory(category);
      if ("error" in result) {
        return { content: [{ type: "text" as const, text: result.error }], isError: true };
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
      const result = await client.findAccount(account);
      if ("error" in result) {
        return { content: [{ type: "text" as const, text: result.error }], isError: true };
      }
      accountId = result.id;
    } else {
      const accounts = await client.getAccountsFresh();
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
          type: "text" as const,
          text: `Multiple payees match "${payee}":\n${payeeResult.matches.map(p => `  - ${p.name}`).join("\n")}\n\nPlease specify which payee you mean.`,
        }],
        isError: true,
      };
    } else if (payeeResult.isNew && !confirm_new_payee) {
      return {
        content: [{
          type: "text" as const,
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
      const result = await client.findCategory(category);
      if ("error" in result) {
        return { content: [{ type: "text" as const, text: result.error }], isError: true };
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
// Update Tool
// =============================================================================

server.tool(
  "update_transaction",
  "Update an existing transaction. Can change cleared status, amount, payee, category, date, or memo.",
  {
    transaction_id: z.string().describe("The transaction ID to update. Get this from get_transactions"),
    cleared: z.enum(["cleared", "uncleared", "reconciled"]).optional().describe("Set the cleared status"),
    amount: z.number().optional().describe("New amount in dollars. Negative for outflows, positive for inflows"),
    payee: z.string().optional().describe("New payee name (fuzzy matched)"),
    category: z.string().optional().describe("New category name (fuzzy matched)"),
    date: z.string().optional().describe("New date ('today', 'yesterday', or YYYY-MM-DD)"),
    memo: z.string().optional().describe("New memo/note"),
  },
  async ({ transaction_id, cleared, amount, payee, category, date, memo }) => {
    const updates: Parameters<typeof client.updateTransaction>[1] = {};

    if (cleared) updates.cleared = cleared;
    if (amount !== undefined) updates.amount = usdToMilliunits(amount);
    if (date) updates.date = parseDate(date);
    if (memo !== undefined) updates.memo = memo;

    if (payee) {
      const result = client.findPayee(payee);
      if ("id" in result) {
        updates.payee_id = result.id;
      } else if (result.matches.length > 0) {
        return {
          content: [{
            type: "text" as const,
            text: `Multiple payees match "${payee}":\n${result.matches.map(p => `  - ${p.name}`).join("\n")}\n\nPlease specify which payee you mean.`,
          }],
          isError: true,
        };
      } else {
        updates.payee_name = payee;
      }
    }

    if (category) {
      const result = await client.findCategory(category);
      if ("error" in result) {
        return { content: [{ type: "text" as const, text: result.error }], isError: true };
      }
      updates.category_id = result.id;
    }

    if (Object.keys(updates).length === 0) {
      return { content: [{ type: "text", text: "No updates specified." }], isError: true };
    }

    const transaction = await client.updateTransaction(transaction_id, updates);

    return {
      content: [{
        type: "text",
        text: `Transaction updated:
Date: ${transaction.date}
Amount: ${formatUSD(transaction.amount)}
Payee: ${transaction.payee_name}
Category: ${transaction.category_name || "Uncategorized"}
Account: ${transaction.account_name}
Cleared: ${transaction.cleared}
${transaction.memo ? `Memo: ${transaction.memo}` : ""}`,
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
