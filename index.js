#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ResourceManagementClient } from "@azure/arm-resources";
import { DefaultAzureCredential } from "@azure/identity";
import { ComputeManagementClient } from "@azure/arm-compute";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} environment variable.`);
  return v;
}

function getSubscriptionId() {
  return requireEnv("AZURE_SUBSCRIPTION_ID");
}

function getCredential() {
  return new DefaultAzureCredential();
}

function getArmClient() {
  return new ResourceManagementClient(getCredential(), getSubscriptionId());
}

function getComputeClient() {
  return new ComputeManagementClient(getCredential(), getSubscriptionId());
}

/**
 * Acquire an ARM management token for calling Azure REST APIs
 * (Cost Management, Resource Graph, Activity Logs).
 */
async function getMgmtToken() {
  const credential = getCredential();
  const scope = "https://management.azure.com/.default";
  const tok = await credential.getToken(scope);
  if (!tok?.token) throw new Error("Failed to acquire ARM access token.");
  return tok.token;
}

function isoDay(d) {
  // Returns YYYY-MM-DD in UTC
  const x = new Date(d);
  const yyyy = x.getUTCFullYear();
  const mm = String(x.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(x.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function humanDuration(ms) {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  return `${days}d ${hours}h ${mins}m`;
}

const server = new McpServer({ name: "azure-arm-mcp", version: "1.0.0" });

/**
 * 1) List resources (read-only)
 */
server.registerTool(
  "list_resources",
  {
    title: "List Azure Resources",
    description: "List all Azure resources in the configured subscription.",
    inputSchema: z.object({}),
  },
  async () => {
    const client = getArmClient();
    const resources = [];
    for await (const r of client.resources.list()) {
      resources.push({
        name: r.name ?? "",
        type: r.type ?? "",
        id: r.id ?? "",
        location: r.location ?? "",
        resourceGroup: r.id?.match(/resourceGroups\/([^/]+)/i)?.[1] ?? "",
        tags: r.tags ?? {},
      });
    }
    return {
      content: [{ type: "text", text: JSON.stringify(resources, null, 2) }],
      isError: false,
    };
  }
);

/**
 * 2) Create/Update RG + tags (merge/replace)
 */
server.registerTool(
  "create_resource_group",
  {
    title: "Create/Update Resource Group (with tags)",
    description:
      "Create or update an Azure resource group. Optionally apply tags with merge/replace.",
    inputSchema: z.object({
      name: z.string().min(1),
      location: z.string().min(1),
      tags: z.record(z.string()).optional(),
      tagMode: z.enum(["merge", "replace"]).optional().default("merge"),
    }),
  },
  async ({ name, location, tags, tagMode }) => {
    const client = getArmClient();

    let finalTags = tags ?? undefined;

    if (tags && tagMode === "merge") {
      let existingTags = {};
      try {
        const rg = await client.resourceGroups.get(name);
        existingTags = rg.tags ?? {};
      } catch {
        existingTags = {};
      }
      finalTags = { ...existingTags, ...tags };
    }

    await client.resourceGroups.createOrUpdate(name, {
      location,
      ...(finalTags ? { tags: finalTags } : {}),
    });

    return {
      content: [
        {
          type: "text",
          text:
            `Resource group '${name}' created/updated in '${location}'.\n` +
            (finalTags
              ? `Tags (${tagMode}):\n${JSON.stringify(finalTags, null, 2)}`
              : "No tags applied."),
        },
      ],
      isError: false,
    };
  }
);

/**
 * 3) Update tags on ANY resourceId (merge/replace)
 */
server.registerTool(
  "update_resource_tags",
  {
    title: "Update Resource Tags (merge/replace)",
    description:
      "Update tags on any Azure resource by resourceId. Merge preserves existing tags; replace overwrites.",
    inputSchema: z.object({
      resourceId: z.string().min(1).describe("Full ARM resource ID"),
      tags: z.record(z.string()).describe("Tags to apply (key/value)"),
      tagMode: z.enum(["merge", "replace"]).optional().default("merge"),
      dryRun: z.boolean().optional().default(false),
    }),
  },
  async ({ resourceId, tags, tagMode, dryRun }) => {
    const client = getArmClient();

    // NOTE: Generic resource operations often need the correct API version per provider.
    // We keep your original approach for now.
    const res = await client.resources.getById(resourceId, "2021-04-01");

    const existing = res.tags ?? {};
    const finalTags = tagMode === "merge" ? { ...existing, ...tags } : { ...tags };

    if (dryRun) {
      return {
        content: [
          {
            type: "text",
            text:
              `DRY RUN ✅ Would update tags (${tagMode}) on:\n${resourceId}\n\n` +
              `Resulting tags:\n${JSON.stringify(finalTags, null, 2)}`,
          },
        ],
        isError: false,
      };
    }

    await client.resources.updateById(resourceId, "2021-04-01", { tags: finalTags });

    return {
      content: [
        {
          type: "text",
          text:
            `Updated tags (${tagMode}) on:\n${resourceId}\n\n` +
            `${JSON.stringify(finalTags, null, 2)}`,
        },
      ],
      isError: false,
    };
  }
);

/**
 * 4) Resize managed disk (increase only, optional dryRun)
 */
server.registerTool(
  "resize_managed_disk",
  {
    title: "Resize Managed Disk (increase only)",
    description:
      "Increase Azure managed disk size (GiB). Does NOT resize partitions inside the OS.",
    inputSchema: z.object({
      resourceGroup: z.string().min(1),
      diskName: z.string().min(1),
      newSizeGiB: z.number().int().positive(),
      dryRun: z.boolean().optional().default(false),
    }),
  },
  async ({ resourceGroup, diskName, newSizeGiB, dryRun }) => {
    const compute = getComputeClient();

    const disk = await compute.disks.get(resourceGroup, diskName);
    const current = disk.diskSizeGB ?? 0;

    if (newSizeGiB <= current) {
      return {
        content: [
          {
            type: "text",
            text: `Blocked: newSizeGiB (${newSizeGiB}) must be greater than current diskSizeGB (${current}).`,
          },
        ],
        isError: true,
      };
    }

    if (dryRun) {
      return {
        content: [
          {
            type: "text",
            text:
              `DRY RUN ✅ Would resize disk '${diskName}' in RG '${resourceGroup}'\n` +
              `From ${current} GiB → ${newSizeGiB} GiB.\n\n` +
              `Note: You must still expand the partition/filesystem inside the VM OS after Azure resizes the disk.`,
          },
        ],
        isError: false,
      };
    }

    await compute.disks.update(resourceGroup, diskName, { diskSizeGB: newSizeGiB });

    return {
      content: [
        {
          type: "text",
          text:
            `Resized disk '${diskName}' in RG '${resourceGroup}'\n` +
            `From ${current} GiB → ${newSizeGiB} GiB.\n\n` +
            `Next step: expand the partition/filesystem inside the VM OS.`,
        },
      ],
      isError: false,
    };
  }
);

/**
 * 5) Delete resource (safe version)
 */
server.registerTool(
  "delete_resource",
  {
    title: "Delete Azure Resource (Safe)",
    description:
      "Delete an Azure resource with strict validation (dev-only). Supports dry-run.",
    inputSchema: z.object({
      resourceId: z.string().min(1),
      resourceName: z.string().min(1),
      reason: z.string().min(1),
      apiVersion: z.string().min(1).optional().default("2021-04-01"),
      dryRun: z.boolean().optional().default(true),
    }),
  },
  async ({ resourceId, resourceName, reason, apiVersion, dryRun }) => {
    if (!resourceId.includes(resourceName)) {
      return {
        content: [{ type: "text", text: "Deletion blocked: resourceName does not match resourceId." }],
        isError: true,
      };
    }

    const normalized = reason.toLowerCase();
    const allowedReasons = ["not needed", "no longer needed", "unused", "not in use", "deprecated"];
    const isValid = allowedReasons.some((r) => normalized.includes(r));
    if (!isValid) {
      return {
        content: [
          {
            type: "text",
            text: `Deletion blocked: invalid reason. Allowed phrases include: ${allowedReasons.join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    if (!resourceId.toLowerCase().includes("dev")) {
      return {
        content: [{ type: "text", text: "Deletion blocked: only 'dev' resources can be deleted." }],
        isError: true,
      };
    }

    const looksLikeArmId =
      resourceId.startsWith("/subscriptions/") && resourceId.toLowerCase().includes("/providers/");
    if (!looksLikeArmId) {
      return {
        content: [{ type: "text", text: "Deletion blocked: resourceId does not look like a valid ARM ID." }],
        isError: true,
      };
    }

    if (dryRun) {
      return {
        content: [
          {
            type: "text",
            text:
              `DRY RUN ✅ Would delete:\n- name: ${resourceName}\n- id: ${resourceId}\n- apiVersion: ${apiVersion}\n- reason: ${reason}\n\nNo deletion performed.`,
          },
        ],
        isError: false,
      };
    }

    const arm = getArmClient();
    console.log(`DELETE APPROVED → ${resourceName} | Reason: ${reason}`);
    await arm.resources.beginDeleteByIdAndWait(resourceId, apiVersion);

    return {
      content: [{ type: "text", text: `Deleted resource '${resourceName}'.` }],
      isError: false,
    };
  }
);

////////////////////////////////////////////////////////////////////////////////
// ✅ NEW TOOL #6: Cost queries (Cost Management Query API)
////////////////////////////////////////////////////////////////////////////////

/**
 * Cost Management Query API endpoint (Usage) lets you query usage/cost at a scope such as:
 * /subscriptions/{subscriptionId} or /subscriptions/{subscriptionId}/resourceGroups/{rgName}. [1](https://dev.to/prakashm88/enhancing-the-vs-code-agent-mode-to-integrate-with-local-tools-using-model-context-protocol-mcp-ccn)
 */
server.registerTool(
  "get_resource_cost",
  {
    title: "Get Resource Cost (Cost Management)",
    description:
      "Query Azure Cost Management for the cost of a resourceId over a window. Requires Cost Management permissions on the scope.",
    inputSchema: z.object({
      resourceId: z.string().min(1).describe("Full ARM resourceId to match"),
      scope: z
        .string()
        .optional()
        .describe("Cost scope. Default: /subscriptions/{AZURE_SUBSCRIPTION_ID}"),
      window: z
        .enum(["Last7Days", "Last30Days", "MonthToDate", "Custom"])
        .optional()
        .default("Last7Days"),
      from: z
        .string()
        .optional()
        .describe("Required if window=Custom. YYYY-MM-DD (UTC)"),
      to: z
        .string()
        .optional()
        .describe("Required if window=Custom. YYYY-MM-DD (UTC)"),
    }),
  },
  async ({ resourceId, scope, window, from, to }) => {
    const token = await getMgmtToken();
    const subId = getSubscriptionId();
    const costScope = scope ?? `/subscriptions/${subId}`;

    let startDay, endDay;
    if (window === "MonthToDate") {
      const now = new Date();
      const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      startDay = isoDay(first);
      endDay = isoDay(now);
    } else if (window === "Last30Days") {
      startDay = isoDay(daysAgo(30));
      endDay = isoDay(new Date());
    } else if (window === "Custom") {
      if (!from || !to) {
        return {
          content: [{ type: "text", text: "Custom window requires both 'from' and 'to' (YYYY-MM-DD)." }],
          isError: true,
        };
      }
      startDay = from;
      endDay = to;
    } else {
      // Last7Days default
      startDay = isoDay(daysAgo(7));
      endDay = isoDay(new Date());
    }

    // Cost Management Query - Usage endpoint. [1](https://dev.to/prakashm88/enhancing-the-vs-code-agent-mode-to-integrate-with-local-tools-using-model-context-protocol-mcp-ccn)
    const url =
      `https://management.azure.com${costScope}` +
      `/providers/Microsoft.CostManagement/query?api-version=2025-03-01`;

    // The API requires timeframe and, if custom, a timePeriod. [1](https://dev.to/prakashm88/enhancing-the-vs-code-agent-mode-to-integrate-with-local-tools-using-model-context-protocol-mcp-ccn)
    const body = {
      type: "Usage",
      timeframe: "Custom",
      timePeriod: { from: `${startDay}T00:00:00Z`, to: `${endDay}T23:59:59Z` },
      dataset: {
        granularity: "Daily",
        aggregation: {
          totalCost: { name: "Cost", function: "Sum" },
        },
        grouping: [{ type: "Dimension", name: "ResourceId" }],
      },
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return {
        content: [
          {
            type: "text",
            text:
              `Cost query failed (${resp.status}).\n` +
              `This usually means missing Cost Management permissions on scope ${costScope}.\n\n` +
              text,
          },
        ],
        isError: true,
      };
    }

    const data = await resp.json();

    const cols = data?.properties?.columns ?? data?.columns ?? [];
    const rows = data?.properties?.rows ?? data?.rows ?? [];

    const idx = (name) => cols.findIndex((c) => (c.name ?? c) === name);
    const idxResource = idx("ResourceId");
    const idxCost = idx("Cost"); // aggregation name is typically "Cost"
    const idxDate = idx("UsageDate") !== -1 ? idx("UsageDate") : idx("Date");

    if (idxResource === -1 || idxCost === -1) {
      return {
        content: [
          {
            type: "text",
            text:
              `Cost query returned an unexpected schema.\n` +
              `Columns: ${JSON.stringify(cols, null, 2)}`,
          },
        ],
        isError: true,
      };
    }

    const target = resourceId.toLowerCase();
    const matching = rows.filter((r) => String(r[idxResource]).toLowerCase() === target);

    const total = matching.reduce((sum, r) => sum + Number(r[idxCost] ?? 0), 0);

    // Build a small daily breakdown preview
    const dailyLines = matching
      .slice(0, 14) // show up to 14 lines to avoid huge output
      .map((r) => {
        const d = idxDate !== -1 ? r[idxDate] : "(date?)";
        const c = r[idxCost];
        return `- ${d}: ${c}`;
      })
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text:
            `Cost for resource (best effort):\n${resourceId}\n` +
            `Scope: ${costScope}\n` +
            `Window: ${startDay} → ${endDay}\n` +
            `Total (sum of matching rows): ${total}\n` +
            `Matched rows: ${matching.length}\n\n` +
            `Daily (first up to 14 rows):\n${dailyLines}\n\n` +
            `Source: Cost Management Query API (Usage).`, // [1](https://dev.to/prakashm88/enhancing-the-vs-code-agent-mode-to-integrate-with-local-tools-using-model-context-protocol-mcp-ccn)[2](https://medium.com/@subbuks/how-to-build-and-publish-a-npm-cli-package-d8c61823bf77)
        },
      ],
      isError: false,
    };
  }
);

////////////////////////////////////////////////////////////////////////////////
// ✅ NEW TOOL #7: Uptime / Age (Resource Graph + Activity Log fallback)
////////////////////////////////////////////////////////////////////////////////

/**
 * Resource Graph lets you query resource inventory across subscriptions. [3](https://www.merge.dev/blog/mcp-tool-description)[4](https://hackernoon.com/publishing-a-nodejs-cli-tool-to-npm-in-less-than-15-minutes)
 * Activity Log records create/update/delete management ops, retained 90 days by default. [5](https://docs.azure.cn/en-us/azure-monitor/platform/activity-log)[6](https://learn.microsoft.com/en-us/rest/api/monitor/activity-logs/list?view=rest-monitor-2015-04-01)[7](https://learn.microsoft.com/en-us/azure/azure-monitor/platform/rest-activity-log?view=rest-loganalytics-2025-02-01)
 *
 * We interpret "uptime" as "age since creation / first-seen".
 */
server.registerTool(
  "get_resource_uptime",
  {
    title: "Get Resource Uptime (Age / First Seen)",
    description:
      "Best-effort resource age: tries Resource Graph for timeCreated; falls back to Activity Log first-seen within retention window.",
    inputSchema: z.object({
      resourceId: z.string().min(1).describe("Full ARM resourceId"),
      lookbackDays: z
        .number()
        .int()
        .positive()
        .max(90)
        .optional()
        .default(90)
        .describe("Activity Log lookback window (max 90 by default retention)."),
    }),
  },
  async ({ resourceId, lookbackDays }) => {
    const token = await getMgmtToken();
    const subId = getSubscriptionId();

    // 1) Try Resource Graph (fast) for a created/firstSeen field.
    // Resource Graph resources endpoint. [3](https://www.merge.dev/blog/mcp-tool-description)
    const rgUrl =
      "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01";

    const rgQuery = `
Resources
| where id =~ '${resourceId}'
| project id, name, type, location,
          timeCreated = todatetime(properties.timeCreated),
          createdTime = todatetime(properties.createdTime),
          createdOn = todatetime(properties.createdOn)
| extend firstSeen = coalesce(timeCreated, createdTime, createdOn)
`;

    const rgBody = {
      subscriptions: [subId],
      query: rgQuery,
      options: { resultFormat: "objectArray" },
    };

    const rgResp = await fetch(rgUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(rgBody),
    });

    let rgRow = null;
    if (rgResp.ok) {
      const rgData = await rgResp.json();
      rgRow = (rgData?.data ?? [])[0] ?? null;
    }

    const now = new Date();

    if (rgRow?.firstSeen) {
      const created = new Date(rgRow.firstSeen);
      const ageMs = now - created;
      return {
        content: [
          {
            type: "text",
            text:
              `Resource age (from Resource Graph):\n` +
              `Name: ${rgRow.name ?? "(unknown)"}\n` +
              `Type: ${rgRow.type ?? "(unknown)"}\n` +
              `Id: ${resourceId}\n` +
              `Created/FirstSeen: ${created.toISOString()}\n` +
              `Age: ${humanDuration(ageMs)}\n\n` +
              `Note: Not all resource types expose a creation timestamp via Resource Graph.`, // [3](https://www.merge.dev/blog/mcp-tool-description)[8](https://stackoverflow.com/questions/48179714/how-can-an-es6-module-be-run-as-a-script-in-node)
          },
        ],
        isError: false,
      };
    }

    // 2) Fallback: Activity Log (within lookbackDays).
    // Activity log list endpoint + required $filter. [6](https://learn.microsoft.com/en-us/rest/api/monitor/activity-logs/list?view=rest-monitor-2015-04-01)[7](https://learn.microsoft.com/en-us/azure/azure-monitor/platform/rest-activity-log?view=rest-loganalytics-2025-02-01)
    // Activity log records management operations (create/update/delete). [5](https://docs.azure.cn/en-us/azure-monitor/platform/activity-log)
    const end = new Date();
    const start = daysAgo(lookbackDays);

    const filter =
      `eventTimestamp ge '${start.toISOString()}' and ` +
      `eventTimestamp le '${end.toISOString()}' and ` +
      `resourceUri eq '${resourceId}'`;

    const actUrl =
      `https://management.azure.com/subscriptions/${subId}` +
      `/providers/Microsoft.Insights/eventtypes/management/values` +
      `?api-version=2015-04-01&$filter=${encodeURIComponent(filter)}` +
      `&$select=${encodeURIComponent("eventTimestamp,operationName,status,subStatus,resourceId,resourceGroupName")}`;

    const actResp = await fetch(actUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!actResp.ok) {
      const text = await actResp.text();
      return {
        content: [
          {
            type: "text",
            text:
              `Uptime fallback (Activity Log) failed (${actResp.status}).\n` +
              `Activity Log is retained for ~90 days by default; older data requires export to Log Analytics/Storage/Event Hub.\n\n` +
              text, // [5](https://docs.azure.cn/en-us/azure-monitor/platform/activity-log)
          },
        ],
        isError: true,
      };
    }

    const actData = await actResp.json();
    const events = actData?.value ?? [];

    if (!events.length) {
      return {
        content: [
          {
            type: "text",
            text:
              `No Activity Log events found for this resource in the last ${lookbackDays} days.\n` +
              `This does not prove the resource is newer/older; Activity Log retention is limited unless exported.\n` +
              `ResourceId: ${resourceId}`, // [5](https://docs.azure.cn/en-us/azure-monitor/platform/activity-log)[9](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
          },
        ],
        isError: false,
      };
    }

    // Find earliest event in the returned window (best-effort "first seen")
    const earliest = events
      .map((e) => ({ ts: new Date(e.eventTimestamp), op: e.operationName?.value ?? e.operationName?.localizedValue ?? "", status: e.status ?? "" }))
      .sort((a, b) => a.ts - b.ts)[0];

    const ageMs = now - earliest.ts;

    return {
      content: [
        {
          type: "text",
          text:
            `Resource age (from Activity Log within last ${lookbackDays} days):\n` +
            `Id: ${resourceId}\n` +
            `Earliest event in window: ${earliest.ts.toISOString()}\n` +
            `Operation: ${earliest.op}\n` +
            `Status: ${earliest.status}\n` +
            `Age since earliest event: ${humanDuration(ageMs)}\n\n` +
            `Note: Activity Log records management operations (create/update/delete) and is retained ~90 days by default unless exported.`, // [5](https://docs.azure.cn/en-us/azure-monitor/platform/activity-log)[6](https://learn.microsoft.com/en-us/rest/api/monitor/activity-logs/list?view=rest-monitor-2015-04-01)[7](https://learn.microsoft.com/en-us/azure/azure-monitor/platform/rest-activity-log?view=rest-loganalytics-2025-02-01)
        },
      ],
      isError: false,
    };
  }
);

// stdio transport (local MCP server spawned by client)
const transport = new StdioServerTransport();
await server.connect(transport);