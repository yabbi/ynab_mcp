import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { YNABClient } from "../client.js";
import { z } from "zod";

export function registerPayeeTools(server: McpServer, client: YNABClient): void {
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
}
