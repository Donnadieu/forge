import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const LINEAR_TOOL = {
  name: "linear_graphql",
  description: "Execute a GraphQL query or mutation against the Linear API",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "GraphQL query or mutation" },
      variables: { type: "object", description: "Optional GraphQL variables" },
    },
    required: ["query"],
  },
};

export async function executeGraphQL(
  query: string,
  variables: Record<string, unknown> | undefined,
  apiKey: string,
  endpoint: string,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
  }

  const json = (await response.json()) as { data?: unknown; errors?: Array<{ message: string }> };

  if (json.errors?.length) {
    return {
      success: false,
      error: `GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`,
    };
  }

  return { success: true, data: json.data };
}

export async function startServer(): Promise<void> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY environment variable is required");
  }
  const endpoint = process.env.LINEAR_ENDPOINT || "https://api.linear.app/graphql";

  const server = new Server(
    { name: "forge-linear", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [LINEAR_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "linear_graphql") {
      return {
        content: [
          { type: "text", text: JSON.stringify({ success: false, error: "Unknown tool" }) },
        ],
        isError: true,
      };
    }

    const args = request.params.arguments as { query: string; variables?: Record<string, unknown> };
    const result = await executeGraphQL(args.query, args.variables, apiKey, endpoint);

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: !result.success,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run when executed directly (not when imported in tests)
const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isDirectExecution) {
  startServer().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
