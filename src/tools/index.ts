import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { McpTool, ToolModule, ToolRegistry } from "../types.js";
import { logger } from "../utils/logger.js";

const TOOLS_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
// Single-dot names only, so index, *.test.* and *.d.ts files are never loaded as tools.
const TOOL_MODULE_FILE = /^(?!index\.)[\w-]+\.(?:js|ts)$/;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function isToolModule(value: unknown): value is ToolModule {
  return typeof value === "object" && value !== null && "tools" in value && Array.isArray(value.tools);
}

/** Imports every module in src/tools/ and indexes its exported `tools` by name. */
export async function loadToolRegistry(): Promise<ToolRegistry> {
  const moduleFiles = (await readdir(TOOLS_DIRECTORY)).filter((file) => TOOL_MODULE_FILE.test(file)).sort();
  const registry = new Map<string, McpTool>();

  for (const file of moduleFiles) {
    const loaded: unknown = await import(pathToFileURL(path.join(TOOLS_DIRECTORY, file)).href);
    if (!isToolModule(loaded)) {
      throw new Error(`Tool module ${file} must export "tools: McpTool[]"`);
    }

    for (const tool of loaded.tools) {
      if (!TOOL_NAME.test(tool.name)) throw new Error(`Invalid tool name "${tool.name}" in ${file}`);
      if (registry.has(tool.name)) throw new Error(`Duplicate tool name "${tool.name}" in ${file}`);
      registry.set(tool.name, tool);
    }
    logger.debug("Loaded tool module", { file, tools: loaded.tools.map((tool) => tool.name) });
  }

  return registry;
}
