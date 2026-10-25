import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// index.ts starts the server on import, so it is exercised as a child process, the way clients run it.
const ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));
const TOKEN = "test-token-0123456789abcdef";

function startServer(env: Record<string, string>) {
  const child = spawn(process.execPath, [ENTRY], {
    env: { PATH: process.env.PATH ?? "", LOG_LEVEL: "info", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exited = once(child, "exit").then(([code]) => code as number | null);
  return { child, exited, stderr: () => stderr };
}

async function freePort(): Promise<number> {
  const probe = createNetServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Exit code of a server expected to stop on its own; one still running after 5s is killed and reported. */
async function exitCode(server: ReturnType<typeof startServer>): Promise<number | null | "still running"> {
  const timer = setTimeout(() => server.child.kill("SIGKILL"), 5_000);
  const code = await server.exited;
  clearTimeout(timer);
  return server.child.signalCode === "SIGKILL" ? "still running" : code;
}

async function waitForListening(server: ReturnType<typeof startServer>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!server.stderr().includes("MCP server listening")) {
    if (server.child.exitCode !== null) throw new Error(`Server exited early:\n${server.stderr()}`);
    if (Date.now() > deadline) throw new Error(`Server did not start:\n${server.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("refuses a non-loopback HOST without MCP_AUTH_TOKEN", async () => {
  const server = startServer({ MCP_TRANSPORT: "http", HOST: "0.0.0.0", PORT: String(await freePort()) });
  assert.equal(await exitCode(server), 1);
  assert.match(server.stderr(), /Refusing to serve on 0\.0\.0\.0 without MCP_AUTH_TOKEN/);
});

test("rejects an MCP_AUTH_TOKEN shorter than 16 characters", async () => {
  const server = startServer({ MCP_TRANSPORT: "http", MCP_AUTH_TOKEN: "short" });
  assert.equal(await exitCode(server), 1);
  assert.match(server.stderr(), /at least 16 characters/);
});

test("rejects an unknown MCP_TRANSPORT", async () => {
  const server = startServer({ MCP_TRANSPORT: "websocket" });
  assert.equal(await exitCode(server), 1);
  assert.match(server.stderr(), /Invalid environment/);
});

test("treats empty variables as unset", async () => {
  const server = startServer({ MCP_TRANSPORT: "", PORT: "", HOST: "", MCP_AUTH_TOKEN: "", MCP_ALLOWED_HOSTS: "" });
  try {
    await waitForListening(server);
    assert.match(server.stderr(), /listening on stdio/);
  } finally {
    server.child.kill("SIGTERM");
    assert.equal(await server.exited, 0);
  }
});

test("HTTP transport with a bearer token", async (t) => {
  const port = await freePort();
  const server = startServer({ MCP_TRANSPORT: "http", PORT: String(port), MCP_AUTH_TOKEN: TOKEN });
  after(async () => {
    server.child.kill("SIGTERM");
    await server.exited;
  });
  await waitForListening(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  const listTools = (authorization?: string) =>
    fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(authorization && { Authorization: authorization }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  await t.test("serves /health without a token", async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", tools: 4 });
  });

  await t.test("rejects a missing token", async () => {
    const response = await listTools();
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /invalid_token/);
  });

  await t.test("rejects a wrong token", async () => {
    assert.equal((await listTools(`Bearer ${TOKEN}x`)).status, 401);
  });

  await t.test("accepts the right token and lists every tool", async () => {
    const response = await listTools(`Bearer ${TOKEN}`);
    const body = await response.text();
    assert.equal(response.status, 200, body);
    for (const name of ["docker_list_containers", "docker_read_logs", "notion_fetch_database", "system_metrics"]) {
      assert.match(body, new RegExp(`"name":"${name}"`));
    }
  });
});
