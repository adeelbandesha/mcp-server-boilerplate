# MCP Server Boilerplate

A modular [Model Context Protocol](https://modelcontextprotocol.io) server template in strict TypeScript, built on MCP TypeScript SDK v2 (spec revision 2026-07-28, with automatic fallback for 2025-era clients). Transport, server registration and tool execution are separate layers, and tools are discovered from `src/tools/`: adding a tool means adding one file.

```
src/
├── index.ts          # Config, transport selection (stdio | http), auth, shutdown
├── server.ts         # McpServer factory: registers every tool from the registry
├── types.ts          # McpTool contract and shared types
├── tools/
│   ├── index.ts      # Auto-discovers every module in this folder
│   ├── docker.ts     # docker_list_containers, docker_read_logs
│   ├── notion.ts     # notion_fetch_database
│   ├── notion.test.ts
│   └── system.ts     # system_metrics
└── utils/
    └── logger.ts     # JSON-line logger on stderr
```

**Stack:** `@modelcontextprotocol/server` 2.x, `@modelcontextprotocol/express` + `@modelcontextprotocol/node` (Streamable HTTP), Express 5, Zod 4, TypeScript 7.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Connecting a client](#connecting-a-client)
- [Configuration](#configuration)
- [Adding a tool](#adding-a-tool)
- [Error handling](#error-handling)
- [Reference tools](#reference-tools)
- [Testing](#testing)
- [Production deployment](#production-deployment-streamable-http)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Requirements

- Node.js 22.9 or newer
- Docker CLI on `PATH`, for the Docker tools only
- A Notion internal integration, for the Notion tool only

Each tool fails on its own with a readable error when its dependency is missing. The rest of the server keeps working.

## Quick start

```bash
npm install
npm run build
cp .env.example .env   # optional; read by npm start / start:http
npm start              # stdio
npm run start:http     # Streamable HTTP on http://127.0.0.1:3000/mcp
```

## Connecting a client

MCP is model-agnostic: any MCP-capable client works, whichever LLM it drives.

### Claude Desktop (stdio)

Add the server to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), using the absolute path to your build, and restart the app:

```json
{
  "mcpServers": {
    "mcp-boilerplate": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-boilerplate/dist/index.js"],
      "env": {
        "NOTION_TOKEN": "ntn_xxx",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

`.env` is not read here; pass variables in `env`.

### Claude Code

```bash
claude mcp add mcp-boilerplate -- node /absolute/path/to/mcp-server-boilerplate/dist/index.js
# or, against a running HTTP server:
claude mcp add --transport http mcp-boilerplate http://127.0.0.1:3000/mcp --header "Authorization: Bearer <token>"
```

### Other clients

Cursor, VS Code, Windsurf, Zed, Cline, Continue, Goose, Gemini CLI and Codex CLI accept the same stdio command (`node /absolute/path/dist/index.js`). Remote integrations (the Anthropic Messages API MCP connector, the OpenAI Responses API `mcp` tool, agent frameworks) use the HTTP endpoint with the bearer token. Cloud-hosted callers need a public HTTPS URL; see [Production deployment](#production-deployment-streamable-http).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | `stdio` for local clients, `http` for Streamable HTTP |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `HOST` | `127.0.0.1` | HTTP bind address |
| `PORT` | `3000` | HTTP port |
| `MCP_AUTH_TOKEN` | unset | Shared secret, at least 16 characters. When set, `/mcp` requires `Authorization: Bearer <token>`. **Required** when `HOST` is not a loopback address. |
| `MCP_ALLOWED_HOSTS` | unset | Comma-separated `Host` header allowlist (DNS-rebinding protection when not bound to localhost) |
| `NOTION_TOKEN` | unset | Notion internal integration secret |

Invalid values stop the server at startup with a readable message. Generate a token with `openssl rand -hex 32`.

## Adding a tool

Create `src/tools/<domain>.ts` and export `tools`. Nothing else needs registering.

```ts
import { z } from "zod";
import type { McpTool, ToolResult } from "../types.js";

const greetInput = z.object({
  name: z.string().min(1).max(100).describe("Who to greet"),
});

const greet: McpTool<typeof greetInput> = {
  name: "greet",
  description: "Return a greeting.",
  inputSchema: greetInput,
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ name }): Promise<ToolResult> {
    return { content: [{ type: "text", text: `Hello, ${name}` }] };
  },
};

export const tools: readonly McpTool[] = [greet];
```

Rules the loader enforces at startup:

- The file name has a single dot (`greet.ts`); `index.ts`, `*.test.ts` and `*.d.ts` are skipped.
- The module exports `tools`, an array.
- Tool names match `^[a-zA-Z0-9_-]{1,64}$` and are unique across all modules.

The Zod schema is both the JSON Schema advertised in `tools/list` and the runtime validator: a handler only ever receives parsed, typed arguments. `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) tell clients how careful to be before calling the tool. Log with `logger` from `src/utils/logger.ts`, never `console.log`: in stdio mode stdout is the protocol channel.

## Error handling

Follows the current MCP spec: protocol errors are JSON-RPC errors, while anything the model could correct or explain comes back as a tool result with `isError: true`.

| Situation | Result |
| --- | --- |
| Unknown tool | JSON-RPC error `-32602` (Invalid params) |
| Arguments fail Zod validation | `isError` result with the validation message, so the model can retry with fixed arguments |
| Handler throws | `isError` result with the error message; full error and stack logged to stderr |
| Expected, recoverable failure | Return `{ isError: true, content: [...] }` yourself (see `NOTION_TOKEN` handling in `notion.ts`) |

## Reference tools

| Tool | Arguments | Notes |
| --- | --- | --- |
| `docker_list_containers` | `all` (bool, default `false`) | `docker ps` as JSON; `all` includes stopped containers |
| `docker_read_logs` | `container`, `tail` (1–5000, default 200), `since` (`30s`/`15m`/`2h`), `timestamps` | stdout and stderr of one container |
| `notion_fetch_database` | `database_id`, `page_size` (1–100, default 25) | Notion API `2026-03-11`: resolves the database's data sources, queries each, returns one Markdown table per data source |
| `system_metrics` | `sample_ms` (50–5000, default 250) | CPU model, per-core and total usage, memory, load average, uptime |

For Notion, share the database with your integration (database menu → *Connections*) or the API answers 404.

## Testing

```bash
npm test               # builds, then runs node --test on dist/**/*.test.js
npm run typecheck      # strict type-check only
```

Interactive, with the official MCP Inspector (opens a browser UI to list and call tools and inspect raw JSON-RPC):

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

Scriptable, with the Inspector CLI:

```bash
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
npx @modelcontextprotocol/inspector --cli node dist/index.js \
  --method tools/call --tool-name system_metrics --tool-arg sample_ms=100
```

Against the HTTP transport:

```bash
MCP_TRANSPORT=http MCP_AUTH_TOKEN=change-me-0123456789 npm start    # terminal 1

npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp \
  --transport http --header "Authorization: Bearer change-me-0123456789" --method tools/list

curl -X POST http://127.0.0.1:3000/mcp \
  -H 'Authorization: Bearer change-me-0123456789' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"system_metrics","arguments":{}}}'

curl http://127.0.0.1:3000/health    # {"status":"ok","tools":4}
```

Set `LOG_LEVEL=debug` to log every tool call with its duration.

## Production deployment (Streamable HTTP)

```bash
MCP_TRANSPORT=http HOST=0.0.0.0 PORT=3000 \
MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
MCP_ALLOWED_HOSTS=mcp.example.com \
node dist/index.js
```

- **Stateless.** `createMcpHandler` builds a fresh `McpServer` for every request and keeps nothing between them, so replicas scale horizontally behind any load balancer, with no sticky sessions or shared store. Clients use a single endpoint, `/mcp`.
- **Both protocol eras.** 2026-07-28 clients and 2025-era clients (`initialize` handshake) are served from the same tool definitions. Legacy session operations (`GET`/`DELETE /mcp`) answer `405`, as the stateless fallback defines.
- **Health check.** `GET /health` returns `{ status, tools }` and is not behind the token.
- **TLS.** Terminate TLS at a reverse proxy or load balancer, and apply rate limiting there.
- **Shutdown.** `SIGINT`/`SIGTERM` abort in-flight requests, close the handler and stop the HTTP listener before exit.

## Security

Defaults:

- **Loopback only.** HTTP binds to `127.0.0.1` and refuses to start on any other address without `MCP_AUTH_TOKEN`.
- **Token check.** The bearer token is compared as a SHA-256 digest in constant time, so neither its content nor its length leaks through timing.
- **Header validation.** On localhost binds, `Host` and `Origin` are validated against DNS rebinding. Use `MCP_ALLOWED_HOSTS` for public hostnames.
- **Argument validation.** Every argument is validated by Zod before a handler runs. Identifiers that reach a command line or URL (container names, Notion IDs) are checked against strict patterns.
- **No shell.** Docker runs through `execFile`, and `--` ends option parsing.
- **Timeouts and limits.** Outbound calls time out after 15 s; Docker output is capped at 10 MB; request bodies are capped by the SDK.
- **Logs on stderr only.** Secrets are never logged.

Things to know before exposing the server:

- **Docker access is effectively host access.** The Docker tools see every container's logs, and logs often contain credentials. Expose them only to trusted users. Run them against a read-only Docker socket proxy, or delete `src/tools/docker.ts`.
- **Tool output is untrusted input to the model.** Container logs and Notion pages can contain prompt-injection text. Every bundled tool is read-only, which limits the damage. Keep any write-capable tool you add behind `destructiveHint: true` and client-side confirmation.
- **`MCP_AUTH_TOKEN` is one shared secret.** For per-user identity or scopes, use OAuth: `requireBearerAuth` and `mcpAuthMetadataRouter` from `@modelcontextprotocol/express`. Tools then receive the verified identity on `ctx.http.authInfo`.
- **Don't commit `.env`.** `.env` and `.env.*` are git-ignored; only `.env.example` is tracked.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Client shows "invalid JSON" or disconnects in stdio mode | Something wrote to stdout. Use `logger`, never `console.log` |
| `spawn docker ENOENT` | Docker CLI is not installed or not on the client's `PATH` |
| `permission denied ... docker.sock` | The user running the server is not allowed to access Docker |
| Notion `404` | The database is not shared with the integration, or the ID is a page or data source ID |
| Notion `401` | `NOTION_TOKEN` is missing or wrong |
| HTTP `401` | Missing or wrong `Authorization: Bearer` header |
| HTTP `403` | `Host` or `Origin` header not allowed; set `MCP_ALLOWED_HOSTS` |
| HTTP `405` on `GET /mcp` | Expected: the stateless endpoint has no session stream |
| HTTP `415` | The POST body is not `Content-Type: application/json` |
| `Refusing to serve on 0.0.0.0 without MCP_AUTH_TOKEN` | Set a token of at least 16 characters, or bind to `127.0.0.1` |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. The workflow:

1. Fork, then `npm install`.
2. Add or change a tool in `src/tools/`, one domain per file, following [Adding a tool](#adding-a-tool).
3. Put tests next to the code as `*.test.ts`, using `node:test`.
4. Run `npm test` and check the tool in the Inspector.
5. Open a pull request describing the tool, its arguments and any new environment variables. Add those variables to `.env.example` and the configuration table above.

## License

[MIT](LICENSE)
