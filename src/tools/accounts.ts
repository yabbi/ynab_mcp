import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { YNABClient } from "../client.js";
import { formatUSD, usdToMilliunits } from "../utils.js";
import { z } from "zod";

export function registerAccountTools(server: McpServer, client: YNABClient): void {
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
}
