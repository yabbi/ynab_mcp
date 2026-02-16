import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const TOOL_CATALOG = [
  { name: "get_budget_summary", description: "Get an overview of your YNAB budget including ready to assign amount, total budgeted, activity, and account balances", category: "budget" },
  { name: "get_monthly_budget", description: "Get budget summary for a specific month", category: "budget" },
  { name: "get_budget_months", description: "List all budget months with budgeted, activity, and to-be-budgeted amounts", category: "budget" },
  { name: "get_accounts", description: "List all accounts with balances (cleared/uncleared)", category: "accounts" },
  { name: "get_account", description: "Get detailed info for a single account by name", category: "accounts" },
  { name: "create_account", description: "Create a new account (checking, savings, credit card, etc.)", category: "accounts" },
  { name: "reconcile_account", description: "Reconcile an account: marks cleared transactions as reconciled with optional balance adjustment", category: "accounts" },
  { name: "get_categories", description: "List all budget categories with budgeted, spent, and available amounts", category: "categories" },
  { name: "get_category", description: "Get details for a specific category including goal information", category: "categories" },
  { name: "get_month_category", description: "Get category details for a specific month (budgeted, activity, balance, goals)", category: "categories" },
  { name: "set_category_budget", description: "Set the budgeted amount for a category in a specific month", category: "categories" },
  { name: "update_category", description: "Update a category's name, note, or goal target", category: "categories" },
  { name: "get_transactions", description: "Get recent transactions with filters by account, category, payee, or date", category: "transactions" },
  { name: "get_transaction", description: "Get a single transaction by its ID", category: "transactions" },
  { name: "get_month_transactions", description: "Get all transactions for a specific budget month", category: "transactions" },
  { name: "create_transaction", description: "Create a new transaction with smart payee matching and split transaction support", category: "transactions" },
  { name: "update_transaction", description: "Update an existing transaction (amount, payee, category, cleared status, date, memo)", category: "transactions" },
  { name: "delete_transaction", description: "Permanently delete a transaction by ID", category: "transactions" },
  { name: "get_scheduled_transactions", description: "List all scheduled (recurring) transactions", category: "scheduled" },
  { name: "create_scheduled_transaction", description: "Create a recurring scheduled transaction", category: "scheduled" },
  { name: "get_payees", description: "List all payees in your budget", category: "payees" },
  { name: "get_payee", description: "Get details for a single payee by name", category: "payees" },
  { name: "update_payee", description: "Rename a payee", category: "payees" },
];

export function registerCatalogTools(server: McpServer): void {
  server.tool(
    "search_tools",
    "Search available YNAB tools by keyword or category. Use this to discover the right tool for a task. Categories: budget, accounts, categories, transactions, scheduled, payees.",
    {
      query: z.string().describe("Search keyword (e.g., 'budget', 'reconcile', 'payee') or category name"),
    },
    async ({ query }) => {
      const q = query.toLowerCase();

      const matches = TOOL_CATALOG.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q)
      );

      if (matches.length === 0) {
        return {
          content: [{
            type: "text",
            text: `No tools found matching "${query}". Available categories: budget, accounts, categories, transactions, scheduled, payees.\n\nAll tools:\n${TOOL_CATALOG.map(t => `  ${t.name}: ${t.description}`).join("\n")}`,
          }],
        };
      }

      const list = matches.map(t => `  ${t.name}: ${t.description}`).join("\n");
      return {
        content: [{
          type: "text",
          text: `Found ${matches.length} tool${matches.length === 1 ? "" : "s"} matching "${query}":\n${list}`,
        }],
      };
    }
  );
}
