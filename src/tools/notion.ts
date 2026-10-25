import { z } from "zod";
import type { McpTool, ToolResult } from "../types.js";

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_API_VERSION = "2026-03-11";
const REQUEST_TIMEOUT_MS = 15_000;
const NOTION_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

const richTextSchema = z.array(z.object({ plain_text: z.string() }));
const namedOptionSchema = z.object({ name: z.string() });

const propertySchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("title"), title: richTextSchema }),
    z.object({ type: z.literal("rich_text"), rich_text: richTextSchema }),
    z.object({ type: z.literal("number"), number: z.number().nullable() }),
    z.object({ type: z.literal("select"), select: namedOptionSchema.nullable() }),
    z.object({ type: z.literal("status"), status: namedOptionSchema.nullable() }),
    z.object({ type: z.literal("multi_select"), multi_select: z.array(namedOptionSchema) }),
    z.object({ type: z.literal("date"), date: z.object({ start: z.string(), end: z.string().nullable() }).nullable() }),
    z.object({ type: z.literal("checkbox"), checkbox: z.boolean() }),
    z.object({ type: z.literal("url"), url: z.string().nullable() }),
    z.object({ type: z.literal("email"), email: z.string().nullable() }),
    z.object({ type: z.literal("phone_number"), phone_number: z.string().nullable() }),
    z.object({ type: z.literal("created_time"), created_time: z.string() }),
    z.object({ type: z.literal("last_edited_time"), last_edited_time: z.string() }),
    z.object({ type: z.literal("unsupported") }),
  ])
  .catch({ type: "unsupported" });

type NotionProperty = z.output<typeof propertySchema>;

const pageSchema = z.object({
  id: z.string(),
  url: z.string(),
  properties: z.record(z.string(), propertySchema),
});

const queryResponseSchema = z.object({
  results: z.array(pageSchema),
  has_more: z.boolean(),
});

export type NotionQueryResponse = z.output<typeof queryResponseSchema>;

const databaseSchema = z.object({
  data_sources: z.array(z.object({ id: z.string().regex(NOTION_ID), name: z.string() })),
});

interface DataSourceRows {
  readonly name: string;
  readonly rows: NotionQueryResponse;
}

function propertyToText(property: NotionProperty): string {
  switch (property.type) {
    case "title":
      return property.title.map((fragment) => fragment.plain_text).join("");
    case "rich_text":
      return property.rich_text.map((fragment) => fragment.plain_text).join("");
    case "number":
      return property.number === null ? "" : String(property.number);
    case "select":
      return property.select?.name ?? "";
    case "status":
      return property.status?.name ?? "";
    case "multi_select":
      return property.multi_select.map((option) => option.name).join(", ");
    case "date":
      return property.date ? [property.date.start, property.date.end].filter(Boolean).join(" → ") : "";
    case "checkbox":
      return property.checkbox ? "✅" : "⬜";
    case "url":
      return property.url ?? "";
    case "email":
      return property.email ?? "";
    case "phone_number":
      return property.phone_number ?? "";
    case "created_time":
      return property.created_time;
    case "last_edited_time":
      return property.last_edited_time;
    case "unsupported":
      return "";
  }
}

function escapeTableCell(value: string): string {
  return value.replace(/[\\|]/g, "\\$&").replace(/\r?\n/g, "<br>");
}

/** Renders one data source query as a Markdown section: a table with the title column first, one row per page. */
export function formatDataSourceAsMarkdown(name: string, response: NotionQueryResponse): string {
  const heading = `## ${name}`;
  if (response.results.length === 0) return `${heading}\n\n_No pages found._`;

  const columns = [...new Set(response.results.flatMap((page) => Object.keys(page.properties)))].sort((left, right) => {
    const isTitle = (column: string): boolean =>
      response.results.some((page) => page.properties[column]?.type === "title");
    return Number(isTitle(right)) - Number(isTitle(left));
  });

  const header = `| ${[...columns, "Link"].map(escapeTableCell).join(" | ")} |`;
  const divider = `| ${[...columns, "Link"].map(() => "---").join(" | ")} |`;
  const rows = response.results.map((page) => {
    const cells = columns.map((column) => {
      const property = page.properties[column];
      return escapeTableCell(property ? propertyToText(property) : "");
    });
    return `| ${[...cells, `[open](${page.url})`].join(" | ")} |`;
  });

  const footer = response.has_more
    ? `_${response.results.length} pages shown; more are available — raise page_size or filter the query._`
    : `_${response.results.length} pages._`;

  return [heading, "", header, divider, ...rows, "", footer].join("\n");
}

async function notionRequest<Schema extends z.ZodType>(
  token: string,
  path: string,
  schema: Schema,
  jsonBody?: Record<string, unknown>,
): Promise<z.output<Schema>> {
  const response = await fetch(`${NOTION_API_URL}${path}`, {
    method: jsonBody ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_API_VERSION,
      ...(jsonBody && { "Content-Type": "application/json" }),
    },
    ...(jsonBody && { body: JSON.stringify(jsonBody) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const apiError = z.object({ message: z.string() }).safeParse(body);
    throw new Error(`Notion API ${response.status}: ${apiError.success ? apiError.data.message : response.statusText}`);
  }
  return schema.parse(body);
}

/** A database holds one or more data sources since API 2025-09-03; rows are queried per data source. */
async function fetchDatabaseRows(token: string, databaseId: string, pageSize: number): Promise<DataSourceRows[]> {
  const database = await notionRequest(token, `/databases/${databaseId}`, databaseSchema);
  return Promise.all(
    database.data_sources.map(async (dataSource) => ({
      name: dataSource.name || dataSource.id,
      rows: await notionRequest(token, `/data_sources/${dataSource.id}/query`, queryResponseSchema, {
        page_size: pageSize,
      }),
    })),
  );
}

const fetchDatabaseInput = z.object({
  database_id: z
    .string()
    .regex(NOTION_ID, "Must be a Notion database UUID")
    .describe("Notion database ID (32 hex characters, dashes optional)"),
  page_size: z.number().int().min(1).max(100).default(25).describe("Maximum number of pages per data source"),
});

const fetchDatabase: McpTool<typeof fetchDatabaseInput> = {
  name: "notion_fetch_database",
  description: "Fetch the pages of a Notion database (every data source in it) as Markdown tables for use as context.",
  inputSchema: fetchDatabaseInput,
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler({ database_id, page_size }): Promise<ToolResult> {
    const token = process.env.NOTION_TOKEN;
    if (!token) {
      return {
        isError: true,
        content: [{ type: "text", text: "NOTION_TOKEN is not set. Create an integration at https://www.notion.so/my-integrations and share the database with it." }],
      };
    }
    const dataSources = await fetchDatabaseRows(token, database_id, page_size);
    const sections = dataSources.map(({ name, rows }) => formatDataSourceAsMarkdown(name, rows));
    const markdown = [`# Notion database \`${database_id}\``, ...sections].join("\n\n");
    return { content: [{ type: "text", text: dataSources.length > 0 ? markdown : `${markdown}\n\n_No data sources._` }] };
  },
};

export const tools: readonly McpTool[] = [fetchDatabase];
