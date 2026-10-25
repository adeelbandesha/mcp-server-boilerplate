import assert from "node:assert/strict";
import { test } from "node:test";
import { loadToolRegistry } from "./index.js";

test("loads every tool module and skips index and test files", async () => {
  const registry = await loadToolRegistry();

  assert.deepEqual([...registry.keys()].sort(), [
    "docker_list_containers",
    "docker_read_logs",
    "notion_fetch_database",
    "system_metrics",
  ]);
});

test("indexes each tool under its own name", async () => {
  for (const [name, tool] of await loadToolRegistry()) {
    assert.equal(tool.name, name);
  }
});
