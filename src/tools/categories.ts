import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { YNABClient } from "../client.js";
import { formatUSD, usdToMilliunits, parseDate } from "../utils.js";
import { z } from "zod";

export function registerCategoryTools(server: McpServer, client: YNABClient): void {
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
}
