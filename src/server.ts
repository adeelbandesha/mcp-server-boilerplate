import { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { McpTool, ToolRegistry, ToolResult } from "./types.js";
import { logger } from "./utils/logger.js";

export const SERVER_INFO = { name: "mcp-server-boilerplate", version: "1.0.0" } as const;

/** Logs the outcome, then rethrows so McpServer returns the failure as an `isError` result the model can act on. */
async function runTool(tool: McpTool, args: z.output<z.ZodObject>): Promise<ToolResult> {
  const startedAt = performance.now();
  try {
    const result = await tool.handler(args);
    logger.debug("Tool completed", { tool: tool.name, durationMs: Math.round(performance.now() - startedAt) });
    return result;
  } catch (error: unknown) {
    logger.error("Tool failed", { tool: tool.name, error });
    throw error;
  }
}

/** Builds a fresh McpServer; called once per stdio connection or HTTP request. */
export function createServer(registry: ToolRegistry): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });

  for (const tool of registry.values()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations && { annotations: tool.annotations }),
      },
      (args) => runTool(tool, args),
    );
  }

  return server;
}
