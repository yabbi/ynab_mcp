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
    subtransactions?: { amount: number; payee_id?: string; payee_name?: string; category_id?: string; memo?: string }[];
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

  async getMonths(): Promise<YNABMonth[]> {
    const { data } = await this.request<{ data: { months: YNABMonth[] } }>(`/budgets/${this.budgetId}/months`);
    return data.months;
  }

  async getMonthCategory(month: string, categoryId: string): Promise<YNABCategory> {
    const { data } = await this.request<{ data: { category: YNABCategory } }>(
      `/budgets/${this.budgetId}/months/${month}/categories/${categoryId}`
    );
    return data.category;
  }

  async updateMonthCategoryBudget(month: string, categoryId: string, budgeted: number): Promise<YNABCategory> {
    const { data } = await this.request<{ data: { category: YNABCategory } }>(
      `/budgets/${this.budgetId}/months/${month}/categories/${categoryId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ category: { budgeted } }),
      }
    );
    return data.category;
  }

  async updateCategory(categoryId: string, updates: { name?: string; note?: string; category_group_id?: string; goal_target?: number }): Promise<YNABCategory> {
    const { data } = await this.request<{ data: { category: YNABCategory } }>(
      `/budgets/${this.budgetId}/categories/${categoryId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ category: updates }),
      }
    );
    return data.category;
  }

  async getMonthTransactions(month: string, sinceDate?: string, type?: string): Promise<YNABTransaction[]> {
    const params = new URLSearchParams();
    if (sinceDate) params.set("since_date", sinceDate);
    if (type) params.set("type", type);
    const query = params.toString();
    const { data } = await this.request<{ data: { transactions: YNABTransaction[] } }>(
      `/budgets/${this.budgetId}/months/${month}/transactions${query ? `?${query}` : ""}`
    );
    return data.transactions.sort((a, b) => b.date.localeCompare(a.date));
  }

  async createAccount(name: string, type: string, balance: number): Promise<YNABAccount> {
    const { data } = await this.request<{ data: { account: YNABAccount } }>(
      `/budgets/${this.budgetId}/accounts`,
      {
        method: "POST",
        body: JSON.stringify({ account: { name, type, balance } }),
      }
    );
    return data.account;
  }

  async getAccount(accountId: string): Promise<YNABAccount> {
    const { data } = await this.request<{ data: { account: YNABAccount } }>(
      `/budgets/${this.budgetId}/accounts/${accountId}`
    );
    return data.account;
  }

  async getTransaction(transactionId: string): Promise<YNABTransaction> {
    const { data } = await this.request<{ data: { transaction: YNABTransaction } }>(
      `/budgets/${this.budgetId}/transactions/${transactionId}`
    );
    return data.transaction;
  }

  async getPayee(payeeId: string): Promise<YNABPayee> {
    const { data } = await this.request<{ data: { payee: YNABPayee } }>(
      `/budgets/${this.budgetId}/payees/${payeeId}`
    );
    return data.payee;
  }

  async updatePayee(payeeId: string, name: string): Promise<YNABPayee> {
    const { data } = await this.request<{ data: { payee: YNABPayee } }>(
      `/budgets/${this.budgetId}/payees/${payeeId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ payee: { name } }),
      }
    );
    // Refresh payee cache since name changed
    await this.refreshCache();
    return data.payee;
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
      let line = `[${t.id}] ${t.date} | ${amount} (${type}) | ${t.cleared} | ${approvalStatus} | ${t.payee_name || "No payee"} | ${t.category_name || "Uncategorized"} | ${t.account_name}${t.memo ? ` | "${t.memo}"` : ""}`;
      if (t.subtransactions && t.subtransactions.length > 0) {
        for (const sub of t.subtransactions) {
          line += `\n  -> ${formatUSD(sub.amount)} | ${sub.category_name || "Uncategorized"}${sub.payee_name ? ` | ${sub.payee_name}` : ""}${sub.memo ? ` | "${sub.memo}"` : ""}`;
        }
      }
      return line;
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

server.tool(
  "get_budget_months",
  "List all budget months with their budgeted, activity, and to-be-budgeted amounts",
  {},
  async () => {
    const months = await client.getMonths();

    const list = months
      .slice(0, 24)
      .map(m => `${m.month}: Budgeted ${formatUSD(m.budgeted)} | Activity ${formatUSD(m.activity)} | To Be Budgeted ${formatUSD(m.to_be_budgeted)} | Income ${formatUSD(m.income)}`)
      .join("\n");

    return {
      content: [{ type: "text", text: `Budget Months (up to 24):\n${list}` }],
    };
  }
);

server.tool(
  "get_month_category",
  "Get detailed category info for a specific month including budgeted, activity, balance, and goal details",
  {
    month: z.string().describe("Month in YYYY-MM-DD format (day is ignored) or 'current' for this month"),
    category: z.string().describe("Category name (fuzzy matched)"),
  },
  async ({ month, category }) => {
    const catResult = await client.findCategory(category);
    if ("error" in catResult) {
      return { content: [{ type: "text" as const, text: catResult.error }], isError: true };
    }

    const monthStr = month === "current" ? "current" : parseDate(month).slice(0, 7) + "-01";
    const c = await client.getMonthCategory(monthStr, catResult.id);

    let output = `Category: ${catResult.category_group_name}: ${c.name} (${monthStr})
Budgeted: ${formatUSD(c.budgeted)}
Activity: ${formatUSD(c.activity)}
Balance: ${formatUSD(c.balance)}`;

    if (c.goal_type) {
      output += `\n\nGoal: ${c.goal_type}`;
      if (c.goal_target) output += `\n  Target: ${formatUSD(c.goal_target)}`;
      if (c.goal_target_month) output += `\n  Target Month: ${c.goal_target_month}`;
      if (c.goal_percentage_complete !== null) output += `\n  Progress: ${c.goal_percentage_complete}% complete`;
      if (c.goal_overall_funded !== null) output += `\n  Funded: ${formatUSD(c.goal_overall_funded)}`;
      if (c.goal_overall_left !== null) output += `\n  Remaining: ${formatUSD(c.goal_overall_left)}`;
      if (c.goal_under_funded !== null && c.goal_under_funded !== 0) output += `\n  Under-funded: ${formatUSD(c.goal_under_funded)}`;
    }

    return {
      content: [{ type: "text", text: output }],
    };
  }
);

server.tool(
  "set_category_budget",
  "Set the budgeted amount for a category in a specific month. This is the core budgeting action.",
  {
    month: z.string().describe("Month in YYYY-MM-DD format (day is ignored) or 'current' for this month"),
    category: z.string().describe("Category name (fuzzy matched)"),
    amount: z.number().describe("Amount to budget in dollars (e.g., 500 for $500.00)"),
  },
  async ({ month, category, amount }) => {
    const catResult = await client.findCategory(category);
    if ("error" in catResult) {
      return { content: [{ type: "text" as const, text: catResult.error }], isError: true };
    }

    const monthStr = month === "current" ? "current" : parseDate(month).slice(0, 7) + "-01";
    const updated = await client.updateMonthCategoryBudget(monthStr, catResult.id, usdToMilliunits(amount));

    return {
      content: [{
        type: "text",
        text: `Budget updated: ${catResult.category_group_name}: ${updated.name} (${monthStr})
Budgeted: ${formatUSD(updated.budgeted)}
Activity: ${formatUSD(updated.activity)}
Balance: ${formatUSD(updated.balance)}`,
      }],
    };
  }
);

server.tool(
  "update_category",
  "Update a category's name, note, or goal target",
  {
    category: z.string().describe("Category name (fuzzy matched)"),
    name: z.string().optional().describe("New category name"),
    note: z.string().optional().describe("New category note"),
    goal_target: z.number().optional().describe("New goal target amount in dollars"),
  },
  async ({ category, name, note, goal_target }) => {
    const catResult = await client.findCategory(category);
    if ("error" in catResult) {
      return { content: [{ type: "text" as const, text: catResult.error }], isError: true };
    }

    const updates: { name?: string; note?: string; goal_target?: number } = {};
    if (name !== undefined) updates.name = name;
    if (note !== undefined) updates.note = note;
    if (goal_target !== undefined) updates.goal_target = usdToMilliunits(goal_target);

    if (Object.keys(updates).length === 0) {
      return { content: [{ type: "text", text: "No updates specified." }], isError: true };
    }

    const updated = await client.updateCategory(catResult.id, updates);

    return {
      content: [{
        type: "text",
        text: `Category updated: ${updated.name}
Budgeted: ${formatUSD(updated.budgeted)}
Activity: ${formatUSD(updated.activity)}
Balance: ${formatUSD(updated.balance)}${updated.goal_target ? `\nGoal Target: ${formatUSD(updated.goal_target)}` : ""}`,
      }],
    };
  }
);

server.tool(
  "get_transaction",
  "Get a single transaction by its ID",
  {
    transaction_id: z.string().describe("The transaction ID"),
  },
  async ({ transaction_id }) => {
    const t = await client.getTransaction(transaction_id);
    const amount = formatUSD(t.amount);
    const type = t.amount < 0 ? "outflow" : "inflow";
    const approvalStatus = t.approved ? "approved" : "pending";

    let output = `Transaction: ${t.id}
Date: ${t.date}
Amount: ${amount} (${type})
Payee: ${t.payee_name || "No payee"}
Category: ${t.category_name || "Uncategorized"}
Account: ${t.account_name}
Cleared: ${t.cleared}
Status: ${approvalStatus}${t.memo ? `\nMemo: ${t.memo}` : ""}`;

    if (t.subtransactions && t.subtransactions.length > 0) {
      output += "\nSplit:";
      for (const sub of t.subtransactions) {
        output += `\n  -> ${formatUSD(sub.amount)} | ${sub.category_name || "Uncategorized"}${sub.payee_name ? ` | ${sub.payee_name}` : ""}${sub.memo ? ` | "${sub.memo}"` : ""}`;
      }
    }

    return {
      content: [{ type: "text", text: output }],
    };
  }
);

server.tool(
  "get_month_transactions",
  "Get all transactions for a specific budget month",
  {
    month: z.string().describe("Month in YYYY-MM-DD format (day is ignored) or 'current' for this month"),
    since_date: z.string().optional().describe("Only show transactions on or after this date"),
    type: z.enum(["uncategorized", "unapproved"]).optional().describe("Filter by type: 'uncategorized' or 'unapproved'"),
  },
  async ({ month, since_date, type }) => {
    const monthStr = month === "current" ? "current" : parseDate(month).slice(0, 7) + "-01";
    const sinceDate = since_date ? parseDate(since_date) : undefined;
    const transactions = await client.getMonthTransactions(monthStr, sinceDate, type);

    if (transactions.length === 0) {
      return { content: [{ type: "text", text: "No transactions found for this month." }] };
    }

    const list = transactions.map(t => {
      const amount = formatUSD(t.amount);
      const txType = t.amount < 0 ? "outflow" : "inflow";
      return `[${t.id}] ${t.date} | ${amount} (${txType}) | ${t.payee_name || "No payee"} | ${t.category_name || "Uncategorized"} | ${t.account_name}${t.memo ? ` | "${t.memo}"` : ""}`;
    }).join("\n");

    return {
      content: [{ type: "text", text: `Transactions for ${monthStr} (${transactions.length}):\n${list}` }],
    };
  }
);

server.tool(
  "get_account",
  "Get detailed info for a single account by name",
  {
    name: z.string().describe("Account name (fuzzy matched)"),
  },
  async ({ name }) => {
    const result = await client.findAccount(name);
    if ("error" in result) {
      return { content: [{ type: "text" as const, text: result.error }], isError: true };
    }

    const a = await client.getAccount(result.id);

    return {
      content: [{
        type: "text",
        text: `Account: ${a.name}
Type: ${a.type}
On Budget: ${a.on_budget}
Balance: ${formatUSD(a.balance)}
Cleared Balance: ${formatUSD(a.cleared_balance)}
Uncleared Balance: ${formatUSD(a.uncleared_balance)}`,
      }],
    };
  }
);

server.tool(
  "create_account",
  "Create a new account in YNAB",
  {
    name: z.string().describe("Account name"),
    type: z.enum(["checking", "savings", "cash", "creditCard", "lineOfCredit", "otherAsset", "otherLiability", "mortgage", "autoLoan", "studentLoan", "personalLoan", "medicalDebt", "otherDebt"]).describe("Account type"),
    balance: z.number().describe("Starting balance in dollars (e.g., 1000 for $1,000.00). Use negative for debt accounts"),
  },
  async ({ name, type, balance }) => {
    const a = await client.createAccount(name, type, usdToMilliunits(balance));

    return {
      content: [{
        type: "text",
        text: `Account created: ${a.name}
Type: ${a.type}
Balance: ${formatUSD(a.balance)}`,
      }],
    };
  }
);

server.tool(
  "get_payee",
  "Get details for a single payee by name",
  {
    name: z.string().describe("Payee name (fuzzy matched)"),
  },
  async ({ name }) => {
    const result = client.findPayee(name);
    if (!("id" in result)) {
      if (result.matches.length > 0) {
        return { content: [{ type: "text" as const, text: result.error! }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `No payee found matching "${name}".` }], isError: true };
    }

    const p = await client.getPayee(result.id);

    return {
      content: [{
        type: "text",
        text: `Payee: ${p.name}
ID: ${p.id}
Transfer Account: ${p.transfer_account_id || "None"}`,
      }],
    };
  }
);

server.tool(
  "update_payee",
  "Update a payee's name",
  {
    payee: z.string().describe("Current payee name (fuzzy matched)"),
    name: z.string().describe("New payee name"),
  },
  async ({ payee, name }) => {
    const result = client.findPayee(payee);
    if (!("id" in result)) {
      if (result.matches.length > 0) {
        return { content: [{ type: "text" as const, text: result.error! }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `No payee found matching "${payee}".` }], isError: true };
    }

    const updated = await client.updatePayee(result.id, name);

    return {
      content: [{
        type: "text",
        text: `Payee updated: ${updated.name} (was "${payee}")`,
      }],
    };
  }
);

server.tool(
  "get_scheduled_transactions",
  "List all scheduled (recurring) transactions",
  {},
  async () => {
    const transactions = await client.getScheduledTransactions();

    if (transactions.length === 0) {
      return { content: [{ type: "text", text: "No scheduled transactions found." }] };
    }

    const list = transactions.map(t => {
      const amount = formatUSD(t.amount);
      const type = t.amount < 0 ? "outflow" : "inflow";
      return `${t.date_next} | ${t.frequency} | ${amount} (${type}) | ${t.payee_name || "No payee"} | ${t.category_name || "Uncategorized"} | ${t.account_name} | First: ${t.date_first}${t.memo ? ` | "${t.memo}"` : ""}`;
    }).join("\n");

    return {
      content: [{ type: "text", text: `Scheduled Transactions (${transactions.length}):\n${list}` }],
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
    subtransactions: z.array(z.object({
      amount: z.number().describe("Amount in dollars (negative=outflow, positive=inflow)"),
      category: z.string().optional().describe("Category name (fuzzy matched)"),
      payee: z.string().optional().describe("Payee name (fuzzy matched, defaults to parent payee)"),
      memo: z.string().optional().describe("Memo for this split line"),
    })).optional().describe("Split into subtransactions. Amounts must sum to the parent amount."),
  },
  async ({ amount, payee, category, account, date, memo, confirm_new_payee, subtransactions }) => {
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

    // Handle split transactions
    let resolvedSubtransactions: { amount: number; payee_id?: string; payee_name?: string; category_id?: string; memo?: string }[] | undefined;
    if (subtransactions && subtransactions.length > 0) {
      // Validate amounts sum to parent
      const subTotal = subtransactions.reduce((sum, s) => sum + s.amount, 0);
      const tolerance = 0.005;
      if (Math.abs(subTotal - amount) > tolerance) {
        return {
          content: [{
            type: "text" as const,
            text: `Subtransaction amounts must sum to the parent amount. Parent: $${amount.toFixed(2)}, subtransactions sum: $${subTotal.toFixed(2)}`,
          }],
          isError: true,
        };
      }

      resolvedSubtransactions = [];
      for (const sub of subtransactions) {
        const resolved: { amount: number; payee_id?: string; payee_name?: string; category_id?: string; memo?: string } = {
          amount: usdToMilliunits(sub.amount),
        };

        // Resolve subtransaction category
        if (sub.category) {
          const catResult = await client.findCategory(sub.category);
          if ("error" in catResult) {
            return { content: [{ type: "text" as const, text: `Subtransaction category error: ${catResult.error}` }], isError: true };
          }
          resolved.category_id = catResult.id;
        }

        // Resolve subtransaction payee (defaults to parent payee)
        if (sub.payee) {
          const payResult = client.findPayee(sub.payee);
          if ("id" in payResult) {
            resolved.payee_id = payResult.id;
          } else if (payResult.matches.length > 0) {
            return {
              content: [{
                type: "text" as const,
                text: `Subtransaction payee error: Multiple payees match "${sub.payee}": ${payResult.matches.map(p => p.name).join(", ")}`,
              }],
              isError: true,
            };
          } else {
            resolved.payee_name = sub.payee;
          }
        }

        if (sub.memo) resolved.memo = sub.memo;
        resolvedSubtransactions.push(resolved);
      }

      // YNAB sets the parent category to "Split" automatically
      categoryId = undefined;
    }

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
      subtransactions: resolvedSubtransactions,
    });

    let confirmText = `Transaction created successfully:
Date: ${transaction.date}
Amount: ${formatUSD(transaction.amount)}
Payee: ${transaction.payee_name}
Category: ${transaction.category_name || "Uncategorized"}
Account: ${transaction.account_name}
${transaction.memo ? `Memo: ${transaction.memo}` : ""}
ID: ${transaction.id}`;

    if (transaction.subtransactions && transaction.subtransactions.length > 0) {
      confirmText += "\nSplit:";
      for (const sub of transaction.subtransactions) {
        confirmText += `\n  -> ${formatUSD(sub.amount)} | ${sub.category_name || "Uncategorized"}${sub.payee_name ? ` | ${sub.payee_name}` : ""}${sub.memo ? ` | "${sub.memo}"` : ""}`;
      }
    }

    return {
      content: [{ type: "text", text: confirmText }],
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

server.tool(
  "reconcile_account",
  "Reconcile an account: marks all cleared transactions as reconciled, and optionally creates a balance adjustment if the real-world balance differs from the cleared balance.",
  {
    account: z.string().describe("Account name (fuzzy matched)"),
    balance: z.number().optional().describe("The real-world account balance in dollars. If provided and it differs from the cleared balance, a 'Reconciliation Balance Adjustment' transaction is created."),
  },
  async ({ account, balance }) => {
    // Resolve account
    const accountResult = await client.findAccount(account);
    if ("error" in accountResult) {
      return { content: [{ type: "text" as const, text: accountResult.error }], isError: true };
    }

    // Fetch all transactions for this account
    const allTransactions = await client.getTransactions({ accountId: accountResult.id, sinceDate: "1900-01-01" });

    // Filter to only cleared (not uncleared, not already reconciled)
    const clearedTransactions = allTransactions.filter(t => t.cleared === "cleared");

    // Mark each cleared transaction as reconciled
    let reconciledCount = 0;
    for (const t of clearedTransactions) {
      await client.updateTransaction(t.id, { cleared: "reconciled" });
      reconciledCount++;
    }

    // Handle balance adjustment if needed
    let adjustmentInfo = "";
    if (balance !== undefined) {
      const targetMilliunits = usdToMilliunits(balance);
      const clearedBalance = accountResult.cleared_balance;

      if (targetMilliunits !== clearedBalance) {
        const adjustmentAmount = targetMilliunits - clearedBalance;
        const today = new Date().toISOString().split("T")[0];

        await client.createTransaction({
          account_id: accountResult.id,
          date: today,
          amount: adjustmentAmount,
          payee_name: "Reconciliation Balance Adjustment",
          cleared: "reconciled",
        });

        adjustmentInfo = `\nBalance adjustment: ${formatUSD(adjustmentAmount)} (cleared balance was ${formatUSD(clearedBalance)}, target ${formatUSD(targetMilliunits)})`;
      } else {
        adjustmentInfo = "\nNo balance adjustment needed - cleared balance matches.";
      }
    }

    return {
      content: [{
        type: "text",
        text: `Reconciled account: ${accountResult.name}\nTransactions reconciled: ${reconciledCount}${adjustmentInfo}`,
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
