const { DefaultAzureCredential } = require("@azure/identity");
const { ResourceManagementClient } = require("@azure/arm-resources");

async function safeDelete(resourceId, resourceName, reason) {
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

  // 🔒 Restrict to dev or test only
  if (!resourceId.toLowerCase().includes("dev") && !resourceId.toLowerCase().includes("test")) {
    throw new Error("Only dev or test resources can be deleted");
  }

  const credential = new DefaultAzureCredential();
  const client = new ResourceManagementClient(
    credential,
    process.env.AZURE_SUBSCRIPTION_ID
  );

  console.log(`DELETE APPROVED → ${resourceName} | Reason: ${reason}`);
  await client.resources.beginDeleteByIdAndWait(resourceId, "2021-04-01");
  console.log(`Deleted resource '${resourceName}'`);
}

const [,, resourceId, resourceName, reason] = process.argv;
if (!resourceId || !resourceName || !reason) {
  console.error("Usage: node safe_delete.js <resourceId> <resourceName> <reason>");
  process.exit(1);
}

safeDelete(resourceId, resourceName, reason).catch(console.error);