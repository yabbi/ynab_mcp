import type {
  YNABAccount,
  YNABBudget,
  YNABCategory,
  YNABCategoryGroup,
  YNABMonth,
  YNABPayee,
  YNABScheduledTransaction,
  YNABTransaction,
} from "./types.js";

// =============================================================================
// YNAB API Client
// =============================================================================

export class YNABClient {
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
