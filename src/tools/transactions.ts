import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { YNABClient } from "../client.js";
import { formatUSD, usdToMilliunits, parseDate } from "../utils.js";
import { z } from "zod";

export function registerTransactionTools(server: McpServer, client: YNABClient): void {
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
    "delete_transaction",
    "\u26A0\uFE0F PERMANENTLY delete a transaction from YNAB. This cannot be undone. Only use this if you're certain you want to remove the transaction.",
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
}
