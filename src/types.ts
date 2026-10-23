import type { z } from "zod";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/server";

export type ToolResult = CallToolResult;

export interface McpTool<InputSchema extends z.ZodObject = z.ZodObject> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly annotations?: ToolAnnotations;
  handler(args: z.output<InputSchema>): Promise<ToolResult>;
}

/** The contract every file in src/tools/ must satisfy to be auto-registered. */
export interface ToolModule {
  readonly tools: readonly McpTool[];
}

export type ToolRegistry = ReadonlyMap<string, McpTool>;

export type TransportMode = "stdio" | "http";

export interface ServerConfig {
  readonly transport: TransportMode;
  readonly host: string;
  readonly port: number;
  readonly authToken: string | undefined;
  readonly allowedHosts: readonly string[] | undefined;
}
