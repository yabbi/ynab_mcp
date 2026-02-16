import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { YNABClient } from "../client.js";
import { formatUSD, usdToMilliunits, parseDate } from "../utils.js";
import { z } from "zod";

export function registerScheduledTools(server: McpServer, client: YNABClient): void {
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
}
