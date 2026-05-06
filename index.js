import { createServer } from "@modelcontextprotocol/sdk/server";
import { DefaultAzureCredential } from "@azure/identity";
import { ResourceManagementClient } from "@azure/arm-resources";

const server = createServer({
  name: "azure-mcp",
  version: "1.0.0",
});

// 🔹 List resources
server.tool(
  "list_resources",
  {
    description: "List all Azure resources",
    inputSchema: {},
  },
  async () => {
    const credential = new DefaultAzureCredential();
    const client = new ResourceManagementClient(
      credential,
      process.env.AZURE_SUBSCRIPTION_ID
    );

    const resources = [];
    for await (const r of client.resources.list()) {
      resources.push({ name: r.name, type: r.type });
    }

    return { content: resources };
  }
);

// 🔹 Create resource group
server.tool(
  "create_resource_group",
  {
    description: "Create a new Azure resource group",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        location: { type: "string" }
      },
      required: ["name", "location"]
    }
  },
  async ({ name, location }) => {
    const credential = new DefaultAzureCredential();
    const client = new ResourceManagementClient(
      credential,
      process.env.AZURE_SUBSCRIPTION_ID
    );

    await client.resourceGroups.createOrUpdate(name, { location });

    return {
      content: `Resource group '${name}' created in ${location}`
    };
  }
);
// to delete resources.
// 🔹 Delete resource (SAFE VERSION)
server.tool(
  "delete_resource",
  {
    description: "Delete an Azure resource with strict validation",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: { type: "string" },
        resourceName: { type: "string" },
        reason: { type: "string" }
      },
      required: ["resourceId", "resourceName", "reason"]
    }
  },
  async ({ resourceId, resourceName, reason }) => {

    // 🔒 Ensure name matches
    if (!resourceId.includes(resourceName)) {
      throw new Error("Resource name does not match resourceId");
    }

    // 🔒 Validate reason
    const normalized = reason.toLowerCase();

    const allowedReasons = [
      "not needed",
      "no longer needed",
      "unused",
      "not in use",
      "deprecated"
    ];

    const isValid = allowedReasons.some(r => normalized.includes(r));

    if (!isValid) {
      throw new Error("Deletion blocked: invalid reason");
    }

    // 🔒 Restrict to dev only
    if (!resourceId.toLowerCase().includes("dev")) {
      throw new Error("Only dev resources can be deleted");
    }

    const credential = new DefaultAzureCredential();
    const client = new ResourceManagementClient(
      credential,
      process.env.AZURE_SUBSCRIPTION_ID
    );

    console.log(`DELETE APPROVED → ${resourceName} | Reason: ${reason}`);

    await client.resources.beginDeleteByIdAndWait(resourceId, "2021-04-01");

    return {
      content: `Deleted resource '${resourceName}'`
    };
  }
);


// 🔹 Start server
server.start();