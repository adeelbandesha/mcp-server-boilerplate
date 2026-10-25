import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDataSourceAsMarkdown, type NotionQueryResponse } from "./notion.js";

test("renders the title column first and escapes table syntax", () => {
  const response: NotionQueryResponse = {
    has_more: true,
    results: [
      {
        id: "page-1",
        url: "https://notion.so/page-1",
        properties: {
          Done: { type: "checkbox", checkbox: true },
          Name: { type: "title", title: [{ plain_text: "Ship | v1" }] },
          Tags: { type: "multi_select", multi_select: [{ name: "api" }, { name: "docs" }] },
        },
      },
    ],
  };

  const markdown = formatDataSourceAsMarkdown("Tasks", response);

  assert.match(markdown, /^\| Name \| Done \| Tags \| Link \|$/m);
  assert.match(markdown, /^\| Ship \\\| v1 \| ✅ \| api, docs \| \[open\]\(https:\/\/notion\.so\/page-1\) \|$/m);
  assert.match(markdown, /more are available/);
});

test("reports an empty database", () => {
  assert.match(formatDataSourceAsMarkdown("Tasks", { has_more: false, results: [] }), /No pages found/);
});

test("uses the data source name as the section heading", () => {
  assert.match(formatDataSourceAsMarkdown("Tasks", { has_more: false, results: [] }), /^## Tasks\n/);
});

test("escapes backslashes so a literal \\| cannot split a cell", () => {
  const response: NotionQueryResponse = {
    has_more: false,
    results: [
      {
        id: "page-1",
        url: "https://notion.so/page-1",
        properties: { Name: { type: "title", title: [{ plain_text: "a\\|b" }] } },
      },
    ],
  };

  assert.match(formatDataSourceAsMarkdown("Tasks", response), /^\| a\\\\\\\|b \| \[open\]/m);
});
