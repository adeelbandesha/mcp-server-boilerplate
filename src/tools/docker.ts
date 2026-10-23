import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { McpTool, ToolResult } from "../types.js";

const execFileAsync = promisify(execFile);

const DOCKER_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const CONTAINER_REFERENCE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

const dockerPsRowSchema = z.object({
  ID: z.string(),
  Names: z.string(),
  Image: z.string(),
  State: z.string(),
  Status: z.string(),
  Ports: z.string(),
  CreatedAt: z.string(),
});

interface DockerOutput {
  stdout: string;
  stderr: string;
}

/** Runs the docker CLI without a shell, so arguments can never be interpreted as shell syntax. */
async function runDocker(args: readonly string[]): Promise<DockerOutput> {
  return execFileAsync("docker", args, { timeout: DOCKER_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
}

const listContainersInput = z.object({
  all: z.boolean().default(false).describe("Include stopped containers"),
});

const listContainers: McpTool<typeof listContainersInput> = {
  name: "docker_list_containers",
  description: "List local Docker containers with their image, state, status and published ports.",
  inputSchema: listContainersInput,
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ all }): Promise<ToolResult> {
    const { stdout } = await runDocker(["ps", "--no-trunc", "--format", "{{json .}}", ...(all ? ["--all"] : [])]);
    const containers = stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => dockerPsRowSchema.parse(JSON.parse(line)))
      .map((row) => ({
        id: row.ID.slice(0, 12),
        name: row.Names,
        image: row.Image,
        state: row.State,
        status: row.Status,
        ports: row.Ports,
        createdAt: row.CreatedAt,
      }));

    return { content: [{ type: "text", text: JSON.stringify({ count: containers.length, containers }, null, 2) }] };
  },
};

const readLogsInput = z.object({
  container: z.string().regex(CONTAINER_REFERENCE, "Must be a container name or ID").describe("Container name or ID"),
  tail: z.number().int().min(1).max(5000).default(200).describe("Number of trailing log lines"),
  since: z
    .string()
    .regex(/^\d+[smh]$/, "Use a relative duration such as 30s, 15m or 2h")
    .optional()
    .describe("Only logs newer than this relative duration"),
  timestamps: z.boolean().default(true),
});

const readContainerLogs: McpTool<typeof readLogsInput> = {
  name: "docker_read_logs",
  description: "Read the most recent log lines (stdout and stderr) of a local Docker container.",
  inputSchema: readLogsInput,
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ container, tail, since, timestamps }): Promise<ToolResult> {
    const args = [
      "logs",
      "--tail",
      String(tail),
      ...(since ? ["--since", since] : []),
      ...(timestamps ? ["--timestamps"] : []),
      "--",
      container,
    ];
    const { stdout, stderr } = await runDocker(args);
    const sections = [
      stdout.trim() && `## stdout\n${stdout.trimEnd()}`,
      stderr.trim() && `## stderr\n${stderr.trimEnd()}`,
    ].filter(Boolean);

    return { content: [{ type: "text", text: sections.join("\n\n") || `No log output for ${container}.` }] };
  },
};

export const tools: readonly McpTool[] = [listContainers, readContainerLogs];
