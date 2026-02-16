import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { YNABClient } from "../client.js";
import { formatUSD, parseDate } from "../utils.js";
import { z } from "zod";

export function registerBudgetTools(server: McpServer, client: YNABClient): void {
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
}
