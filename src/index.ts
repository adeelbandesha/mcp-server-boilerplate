import { createHash, timingSafeEqual } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { createServer } from "./server.js";
import { loadToolRegistry } from "./tools/index.js";
import type { ServerConfig, ToolRegistry } from "./types.js";
import { logger } from "./utils/logger.js";

type ShutdownHandler = () => Promise<void>;

const MCP_ENDPOINT = "/mcp";
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1"]);

const environmentSchema = z.object({
  MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MCP_AUTH_TOKEN: z.string().min(16, "MCP_AUTH_TOKEN must be at least 16 characters").optional(),
  MCP_ALLOWED_HOSTS: z.string().min(1).optional(),
});

function loadConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  // Empty values (e.g. `PORT=` or compose `${UNSET}`) mean "unset", not invalid.
  const parsed = environmentSchema.safeParse(Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== "")));
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  const { MCP_TRANSPORT, HOST, PORT, MCP_AUTH_TOKEN, MCP_ALLOWED_HOSTS } = parsed.data;
  return {
    transport: MCP_TRANSPORT,
    host: HOST,
    port: PORT,
    authToken: MCP_AUTH_TOKEN,
    allowedHosts: MCP_ALLOWED_HOSTS?.split(",").map((host) => host.trim()).filter(Boolean),
  };
}

function logProtocolError(error: Error): void {
  logger.error("MCP transport error", { error });
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Compares digests so neither the token's content nor its length leaks through timing. */
function requireStaticBearerToken(expectedToken: string) {
  const expectedDigest = sha256(`Bearer ${expectedToken}`);
  return (request: Request, response: Response, next: NextFunction): void => {
    if (timingSafeEqual(sha256(request.headers.authorization ?? ""), expectedDigest)) {
      next();
      return;
    }
    response.status(401).set("WWW-Authenticate", 'Bearer error="invalid_token"').json({ error: "invalid_token" });
  };
}

function startStdio(registry: ToolRegistry): ShutdownHandler {
  const connection = serveStdio(() => createServer(registry), { onerror: logProtocolError });
  logger.info("MCP server listening on stdio", { tools: registry.size });
  return () => connection.close();
}

/** Stateless Streamable HTTP: a fresh McpServer answers each request, so replicas scale horizontally without sticky sessions. */
async function startHttp(registry: ToolRegistry, config: ServerConfig): Promise<ShutdownHandler> {
  if (!config.authToken && !LOOPBACK_HOSTS.has(config.host)) {
    throw new Error(`Refusing to serve on ${config.host} without MCP_AUTH_TOKEN; set it or bind HOST to 127.0.0.1`);
  }

  const app = createMcpExpressApp({
    host: config.host,
    ...(config.allowedHosts && { allowedHosts: [...config.allowedHosts] }),
  });
  const mcpHandler = createMcpHandler(() => createServer(registry), { onerror: logProtocolError });
  const handleNodeRequest = toNodeHandler(mcpHandler, { onerror: logProtocolError });
  app.disable("x-powered-by");

  app.get("/health", (_request: Request, response: Response) => {
    response.json({ status: "ok", tools: registry.size });
  });

  if (config.authToken) {
    app.use(MCP_ENDPOINT, requireStaticBearerToken(config.authToken));
  }

  app.all(MCP_ENDPOINT, (request: Request, response: Response) => handleNodeRequest(request, response, request.body));

  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const listening = app.listen(config.port, config.host, (error?: Error) => (error ? reject(error) : resolve(listening)));
  });
  logger.info("MCP server listening on Streamable HTTP", {
    url: `http://${config.host}:${config.port}${MCP_ENDPOINT}`,
    tools: registry.size,
  });

  return async () => {
    await mcpHandler.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
}

/** Entry point: load config and tools, start the selected transport, and close it cleanly on signals. */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const registry = await loadToolRegistry();
  const shutdown = config.transport === "http" ? await startHttp(registry, config) : startStdio(registry);

  let shuttingDown = false;
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) process.exit(1); // second signal forces exit if graceful close hangs
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    shutdown()
      .catch((error: unknown) => logger.error("Shutdown failed", { error }))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
}

main().catch((error: unknown) => {
  logger.error("Fatal startup error", { error });
  process.exit(1);
});
