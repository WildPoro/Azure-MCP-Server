import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  console.log("Starting MCP test client...");

  // Create MCP client
  const client = new Client({
    name: "test-client",
    version: "1.0.0",
  });

  // Spawn the MCP server as a local process
  const transport = new StdioClientTransport({
    command: "azure-arm-mcp",
    args: [],
    env: {
      ...process.env,
      AZURE_SUBSCRIPTION_ID: process.env.AZURE_SUBSCRIPTION_ID,
    },
  });

  await client.connect(transport);
  console.log("✅ Connected to MCP server\n");

  /**
   * 1) List available tools
   */
  console.log("=== Available MCP Tools ===");
  const tools = await client.listTools();
  console.dir(tools, { depth: null });

  /**
   * 2) Call list_resources
   */
  console.log("\n=== Calling list_resources ===");
  const listResult = await client.callTool({
    name: "list_resources",
    arguments: {},
  });
  console.dir(listResult, { depth: null });

  /**
   * 3) Call delete_resource (SAFE – DRY RUN)
   *
   * ⚠️ Replace values below with a REAL DEV resource
   * The delete will NOT happen because dryRun = true
   */
  console.log("\n=== Calling delete_resource (DRY RUN) ===");
  const deleteResult = await client.callTool({
    name: "delete_resource",
    arguments: {
      resourceId:
        "/subscriptions/YOUR-SUB-ID/resourceGroups/rg-dev/providers/Microsoft.Web/sites/example-dev-resource",
      resourceName: "example-dev-resource",
      reason: "no longer needed",
      dryRun: true
    },
  });
  console.dir(deleteResult, { depth: null });

  await client.close();
  console.log("\n✅ MCP test client finished");
}

// Run
main().catch((err) => {
  console.error("❌ Client error:", err);
  process.exit(1);
});
