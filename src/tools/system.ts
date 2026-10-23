import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { McpTool, ToolResult } from "../types.js";

interface CpuTimes {
  idle: number;
  total: number;
}

function readCpuTimes(): CpuTimes[] {
  return os.cpus().map(({ times }) => ({
    idle: times.idle,
    total: times.user + times.nice + times.sys + times.idle + times.irq,
  }));
}

function toPercent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}

/** CPU busy percentage per core, from the delta of two os.cpus() samples. */
async function sampleCpuUsage(sampleMs: number): Promise<number[]> {
  const before = readCpuTimes();
  await sleep(sampleMs);
  return readCpuTimes().map((after, core) => {
    const start = before[core] ?? { idle: 0, total: 0 };
    const totalDelta = after.total - start.total;
    return toPercent(totalDelta - (after.idle - start.idle), totalDelta);
  });
}

const metricsInput = z.object({
  sample_ms: z.number().int().min(50).max(5000).default(250).describe("CPU sampling window in milliseconds"),
});

const systemMetrics: McpTool<typeof metricsInput> = {
  name: "system_metrics",
  description: "Snapshot of host hardware: CPU model, per-core and total load, memory usage, load average and uptime.",
  inputSchema: metricsInput,
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ sample_ms }): Promise<ToolResult> {
    const perCoreUsage = await sampleCpuUsage(sample_ms);
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const averageUsage = perCoreUsage.reduce((sum, usage) => sum + usage, 0) / Math.max(perCoreUsage.length, 1);

    const snapshot = {
      host: { hostname: os.hostname(), platform: os.platform(), release: os.release(), arch: os.arch() },
      uptimeSeconds: Math.round(os.uptime()),
      loadAverage: os.loadavg(),
      cpu: {
        model: os.cpus()[0]?.model ?? "unknown",
        cores: perCoreUsage.length,
        usagePercent: Math.round(averageUsage * 10) / 10,
        perCoreUsagePercent: perCoreUsage,
      },
      memory: {
        totalBytes: totalMemory,
        freeBytes: freeMemory,
        usedBytes: totalMemory - freeMemory,
        usedPercent: toPercent(totalMemory - freeMemory, totalMemory),
      },
    };

    return { content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }] };
  },
};

export const tools: readonly McpTool[] = [systemMetrics];
