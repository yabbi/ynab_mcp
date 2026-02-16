import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { YNABClient } from "./client.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerBudgetTools } from "./tools/budget.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerCategoryTools } from "./tools/categories.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerScheduledTools } from "./tools/scheduled.js";
import { registerPayeeTools } from "./tools/payees.js";

const server = new McpServer({
  name: "ynab",
  version: "1.0.0",
  description: "YNAB budgeting tools. Use for anything related to personal finance, budgets, bank accounts, spending categories, transactions, payees, or recurring payments. Search tools with search_tools to discover available capabilities.",
});

async function main() {
  const token = process.env.YNAB_API_TOKEN;
  if (!token) {
    throw new Error("YNAB_API_TOKEN environment variable is required");
  }

  const client = new YNABClient(token, process.env.YNAB_BUDGET_ID);
  await client.initialize();

  // Register all tools
  registerCatalogTools(server);
  registerBudgetTools(server, client);
  registerAccountTools(server, client);
  registerCategoryTools(server, client);
  registerTransactionTools(server, client);
  registerScheduledTools(server, client);
  registerPayeeTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Failed to start YNAB MCP server:", error);
  process.exit(1);
});
