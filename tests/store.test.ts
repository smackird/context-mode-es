/**
 * ContentStoreES — Elasticsearch-backed Knowledge Base Tests
 *
 * Tests chunking, indexing, search, multi-source, and edge cases
 * using real fixtures from Context7 and MCP tools.
 */

import { describe, test, expect } from "vitest";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import {
  createTestContentStore,
  cleanupIndex,
  refreshIndex,
} from "./shared/es-test-helpers.js";
import { ContentStoreES, cleanupStaleIndices } from "../src/store-es.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "fixtures");

const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const fn of cleanups) {
    try { await fn(); } catch {}
  }
});

async function createStore(): Promise<{ store: ContentStoreES; indexName: string }> {
  const { store, indexName } = await createTestContentStore();
  cleanups.push(() => cleanupIndex(indexName));
  return { store, indexName };
}

describe("Schema & Lifecycle", () => {
  test("creates store with empty stats", async () => {
    const { store } = await createStore();
    const stats = await store.getStats();
    assert.equal(stats.sources, 0);
    assert.equal(stats.chunks, 0);
    assert.equal(stats.codeChunks, 0);
    await store.close();
  });

  test("close is idempotent", async () => {
    const { store } = await createStore();
    await store.close();
    // second close should not throw
    await store.close();
  });
});

describe("Basic Indexing", () => {
  test("index simple markdown content", async () => {
    const { store, indexName } = await createStore();
    const result = await store.index({
      content: "# Hello\n\nThis is a test document.",
      source: "test-doc",
    });
    assert.equal(result.label, "test-doc");
    assert.equal(result.totalChunks, 1);
    assert.equal(result.codeChunks, 0);
    await store.close();
  });

  test("index content with code blocks", async () => {
    const { store } = await createStore();
    const result = await store.index({
      content:
        "# API Guide\n\n```javascript\nconsole.log('hello');\n```\n\n## Usage\n\nSome text.",
      source: "api-guide",
    });
    assert.ok(result.totalChunks >= 1);
    assert.ok(result.codeChunks >= 1, "Should detect code chunks");
    await store.close();
  });

  test("index empty content throws (falsy content requires path)", async () => {
    const { store } = await createStore();
    await assert.rejects(
      () => store.index({ content: "", source: "empty" }),
      /Either content or path/,
    );
    await store.close();
  });

  test("index whitespace-only content returns 0 chunks", async () => {
    const { store } = await createStore();
    const result = await store.index({
      content: "   \n\n   \n",
      source: "whitespace",
    });
    assert.equal(result.totalChunks, 0);
    await store.close();
  });

  test("index from file path", async () => {
    const { store } = await createStore();
    const result = await store.index({
      path: join(fixtureDir, "context7-react-docs.md"),
      source: "Context7: React useEffect",
    });
    assert.ok(result.totalChunks > 0, "Should chunk the fixture");
    assert.ok(result.codeChunks > 0, "React docs have code blocks");
    assert.equal(result.label, "Context7: React useEffect");
    await store.close();
  });

  test("index throws when neither content nor path provided", async () => {
    const { store } = await createStore();
    await assert.rejects(
      () => store.index({}),
      /Either content or path/,
    );
    await store.close();
  });

  test("stats update after indexing", async () => {
    const { store, indexName } = await createStore();
    await store.index({
      content: "# Title\n\nSome content.\n\n## Section\n\nMore content.",
      source: "doc-1",
    });
    await refreshIndex(indexName);
    const stats = await store.getStats();
    assert.ok(stats.sources >= 1);
    assert.ok(stats.chunks >= 1);
    await store.close();
  });
});

describe("Heading-Aware Chunking", () => {
  test("splits on H1-H4 headings", async () => {
    const { store } = await createStore();
    const result = await store.index({
      content:
        "# H1\n\nContent 1\n\n## H2\n\nContent 2\n\n### H3\n\nContent 3\n\n#### H4\n\nContent 4",
      source: "headings",
    });
    assert.equal(result.totalChunks, 4, "Should split into 4 chunks");
    await store.close();
  });

  test("splits on --- separators (Context7 format)", async () => {
    const { store } = await createStore();
    const result = await store.index({
      content:
        "### Section A\n\nContent A\n\n---\n\n### Section B\n\nContent B\n\n---\n\n### Section C\n\nContent C",
      source: "context7-style",
    });
    assert.equal(result.totalChunks, 3, "Should split on --- separators");
    await store.close();
  });

  test("keeps code blocks intact (never split mid-block)", async () => {
    const { store, indexName } = await createStore();
    const result = await store.index({
      content:
        '# Example\n\n```javascript\nfunction hello() {\n  console.log("world");\n}\nhello();\n```\n\nMore text after code.',
      source: "code-intact",
    });
    assert.equal(result.totalChunks, 1, "Code block stays with heading");

    await refreshIndex(indexName);
    const results = await store.search("hello function", 1);
    assert.ok(results.length > 0);
    assert.ok(
      results[0].content.includes("console.log"),
      "Code block should be intact",
    );
    assert.ok(
      results[0].content.includes("hello()"),
      "Full code block preserved",
    );
    await store.close();
  });

  test("tracks heading hierarchy in titles", async () => {
    const { store, indexName } = await createStore();
    await store.index({
      content:
        "# React\n\n## Hooks\n\n### useEffect\n\nEffect documentation here.",
      source: "hierarchy",
    });
    await refreshIndex(indexName);
    const results = await store.search("Effect documentation", 1);
    assert.ok(results.length > 0);
    assert.ok(
      results[0].title.includes("React"),
      `Title should include H1, got: ${results[0].title}`,
    );
    assert.ok(
      results[0].title.includes("Hooks"),
      `Title should include H2, got: ${results[0].title}`,
    );
    assert.ok(
      results[0].title.includes("useEffect"),
      `Title should include H3, got: ${results[0].title}`,
    );
    await store.close();
  });

  test("marks chunks with code as 'code' contentType", async () => {
    const { store, indexName } = await createStore();
    await store.index({
      content:
        "# Prose\n\nJust text.\n\n# Code\n\n```python\nprint('hello')\n```",
      source: "mixed",
    });
    await refreshIndex(indexName);

    const proseResults = await store.search("Just text", 1);
    assert.ok(proseResults.length > 0);
    assert.equal(proseResults[0].contentType, "prose");

    const codeResults = await store.search("python print hello", 1);
    assert.ok(codeResults.length > 0);
    assert.equal(codeResults[0].contentType, "code");

    await store.close();
  });
});

describe("BM25 Search", () => {
  test("basic keyword search returns results", async () => {
    const { store, indexName } = await createStore();
    await store.index({
      content:
        "# Authentication\n\nUse JWT tokens for API auth.\n\n# Caching\n\nRedis for session caching.",
      source: "docs",
    });
    await refreshIndex(indexName);
    const results = await store.search("JWT authentication", 2);
    assert.ok(results.length > 0, "Should find results");
    assert.ok(
      results[0].content.includes("JWT"),
      "First result should be about JWT",
    );
    await store.close();
  });

  test("title match weighted higher than content match", async () => {
    const { store, indexName } = await createStore();
    await store.index({
      content:
        "# useEffect\n\nThe effect hook.\n\n# useState\n\nuseEffect is mentioned here in passing.",
      source: "hooks",
    });
    await refreshIndex(indexName);
    const results = await store.search("useEffect", 2);
    assert.ok(results.length >= 1);
    assert.ok(
      results[0].title.includes("useEffect"),
      `Title match should rank first, got title: ${results[0].title}`,
    );
    await store.close();
  });

  test("stemming matches word variants", async () => {
    const { store, indexName } = await createStore();
    await store.index({
      content:
        "# Connecting\n\nEstablish connections to the database.\n\n# Caching\n\nCache your responses.",
      source: "stemming",
    });
    await refreshIndex(indexName);
    const results = await store.search("connect", 1);
    assert.ok(results.length > 0);
    assert.ok(
      results[0].content.includes("connections") ||
        results[0].title.includes("Connecting"),
      "Stemming should match variants",
    );
    await store.close();
  });

  test("search with no results returns empty array", async () => {
    const { store, indexName } = await createStore();
    await store.index({
      content: "# React\n\nComponent lifecycle.",
      source: "react",
    });
    await refreshIndex(indexName);
    const results = await store.search("kubernetes deployment yaml", 3);
    assert.equal(results.length, 0, "Should return empty for irrelevant query");
    await store.close();
  });

  test("limit parameter controls result count", async () => {
    const { store, indexName } = await createStore();
    await store.index({
      content:
        "# A\n\nApple.\n\n# B\n\nBanana.\n\n# C\n\nCherry.\n\n# D\n\nDate.",
      source: "fruits",
    });
    await refreshIndex(indexName);
    const results1 = await store.search("fruit", 1);
    assert.ok(results1.length <= 1);

    const results3 = await store.search("fruit", 10);
    assert.ok(results3.length >= 0);
    await store.close();
  });

  test("results include source label", async () => {
    const { store, indexName } = await createStore();
    await store.index({
      content: "# Setup\n\nInstall the package.",
      source: "Context7: React docs",
    });
    await refreshIndex(indexName);
    const results = await store.search("Install package", 1);
    assert.ok(results.length > 0);
    assert.equal(results[0].source, "Context7: React docs");
    await store.close();
  });

  test("results include rank score", async () => {
    const { store, indexName } = await createStore();
    await store.index({
      content: "# Test\n\nSome test content here.",
      source: "ranked",
    });
    await refreshIndex(indexName);
    const results = await store.search("test content", 1);
    assert.ok(results.length > 0);
    assert.equal(typeof results[0].rank, "number");
    await store.close();
  });
});

describe("Multi-Source Indexing", () => {
  test("search across multiple indexed sources", async () => {
    const { store, indexName } = await createStore();
    await store.index({
      content: "# React Hooks\n\nuseEffect for side effects.",
      source: "Context7: React",
    });
    await store.index({
      content: "# Supabase Auth\n\nRow Level Security policies.",
      source: "Context7: Supabase",
    });
    await store.index({
      content: "# Tailwind\n\nResponsive breakpoints with sm, md, lg.",
      source: "Context7: Tailwind",
    });
    await refreshIndex(indexName);

    const reactResults = await store.search("useEffect", 1);
    assert.ok(reactResults.length > 0);
    assert.equal(reactResults[0].source, "Context7: React");

    const supaResults = await store.search("Row Level Security", 1);
    assert.ok(supaResults.length > 0);
    assert.equal(supaResults[0].source, "Context7: Supabase");

    const twResults = await store.search("responsive breakpoints", 1);
    assert.ok(twResults.length > 0);
    assert.equal(twResults[0].source, "Context7: Tailwind");

    const stats = await store.getStats();
    assert.equal(stats.sources, 3);
    await store.close();
  });

  test("re-indexing same source replaces previous entry (dedup)", async () => {
    const { store, indexName } = await createStore();
    await store.index({
      content: "# Part 1\n\nFirst batch.",
      source: "incremental",
    });
    await store.index({
      content: "# Part 2\n\nSecond batch.",
      source: "incremental",
    });
    await refreshIndex(indexName);
    const stats = await store.getStats();
    assert.equal(stats.sources, 1, "Dedup replaces previous source with same label");
    assert.ok(stats.chunks >= 1);
    await store.close();
  });
});

describe("Fixture-Based Tests (Real MCP Output)", () => {
  test("Context7 React docs: index and search code examples", async () => {
    const { store, indexName } = await createStore();
    const content = readFileSync(
      join(fixtureDir, "context7-react-docs.md"),
      "utf-8",
    );
    const result = await store.index({
      content,
      source: "Context7: React useEffect",
    });
    assert.ok(result.totalChunks >= 3, `Expected >=3 chunks, got ${result.totalChunks}`);
    assert.ok(result.codeChunks >= 1, "Should detect code chunks");
    await refreshIndex(indexName);

    const cleanup = await store.search("cleanup function disconnect", 2);
    assert.ok(cleanup.length > 0, "Should find cleanup pattern");
    assert.ok(
      cleanup[0].content.includes("disconnect"),
      "Should contain exact disconnect code",
    );

    const fetch = await store.search("fetch data ignore stale", 2);
    assert.ok(fetch.length > 0, "Should find fetch pattern");
    assert.ok(
      fetch[0].content.includes("ignore"),
      "Should contain ignore flag pattern",
    );

    await store.close();
  });

  test("Context7 Next.js docs: index and search", async () => {
    const { store, indexName } = await createStore();
    const content = readFileSync(
      join(fixtureDir, "context7-nextjs-docs.md"),
      "utf-8",
    );
    const result = await store.index({
      content,
      source: "Context7: Next.js App Router",
    });
    assert.ok(result.totalChunks >= 2, `Expected >=2 chunks, got ${result.totalChunks}`);
    await refreshIndex(indexName);

    const results = await store.search("App Router", 1);
    assert.ok(results.length > 0);
    assert.equal(results[0].source, "Context7: Next.js App Router");
    await store.close();
  });

  test("Context7 Tailwind docs: index and search", async () => {
    const { store, indexName } = await createStore();
    const content = readFileSync(
      join(fixtureDir, "context7-tailwind-docs.md"),
      "utf-8",
    );
    const result = await store.index({
      content,
      source: "Context7: Tailwind CSS",
    });
    assert.ok(result.totalChunks >= 1);
    await refreshIndex(indexName);

    const results = await store.search("Tailwind", 1);
    assert.ok(results.length > 0);
    assert.equal(results[0].source, "Context7: Tailwind CSS");
    await store.close();
  });

  test("MCP tools JSON: index and search tool signatures", async () => {
    const { store } = await createStore();
    const raw = readFileSync(join(fixtureDir, "mcp-tools.json"), "utf-8");
    const tools = JSON.parse(raw);

    const markdown = tools
      .map(
        (t: { name: string; description: string }) =>
          `### ${t.name}\n\n${t.description}`,
      )
      .join("\n\n---\n\n");

    const result = await store.index({
      content: markdown,
      source: "MCP: tools/list",
    });
    assert.ok(
      result.totalChunks >= 5,
      `Expected >=5 chunks for 40 tools, got ${result.totalChunks}`,
    );
    await store.close();
  });
});

describe("Query Sanitization", () => {
  test("handles special characters in query", async () => {
    const { store, indexName } = await createStore();
    await store.index({
      content: "# Test\n\nSome content here.",
      source: "sanitize",
    });
    await refreshIndex(indexName);
    // These should not throw
    await store.search('test "quoted"', 1);
    await store.search("test AND OR NOT", 1);
    await store.search("test()", 1);
    await store.search("test*", 1);
    await store.search("test:value", 1);
    await store.search("test^2", 1);
    await store.search("{test}", 1);
    await store.search("NEAR/3", 1);
    await store.close();
  });

  test("empty query returns empty results", async () => {
    const { store, indexName } = await createStore();
    await store.index({
      content: "# Doc\n\nContent.",
      source: "empty-q",
    });
    await refreshIndex(indexName);
    const results = await store.search("", 3);
    assert.equal(results.length, 0, "Empty query should return no results");
    await store.close();
  });
});

describe("Edge Cases", () => {
  test("content with no headings creates single chunk", async () => {
    const { store } = await createStore();
    const result = await store.index({
      content: "Just plain text without any markdown headings.",
      source: "plain",
    });
    assert.equal(result.totalChunks, 1);
    await store.close();
  });

  test("nested code blocks (triple backtick inside fenced)", async () => {
    const { store, indexName } = await createStore();
    const content =
      '# Example\n\n````markdown\n```javascript\nconsole.log("nested");\n```\n````';
    const result = await store.index({ content, source: "nested" });
    assert.ok(result.totalChunks >= 1);
    assert.ok(result.codeChunks >= 1);
    await refreshIndex(indexName);

    const results = await store.search("console.log", 1);
    assert.ok(results.length > 0, "Should find content inside nested code blocks");
    assert.ok(results[0].content.includes("nested") || results[0].content.includes("console"), "Nested code preserved");
    await store.close();
  });

  test("very long content chunks correctly", async () => {
    const { store } = await createStore();
    const sections = Array.from(
      { length: 20 },
      (_, i) => `## Section ${i}\n\nContent for section ${i}.\n`,
    ).join("\n");
    const result = await store.index({
      content: sections,
      source: "long-doc",
    });
    assert.equal(
      result.totalChunks,
      20,
      `Expected 20 chunks, got ${result.totalChunks}`,
    );
    await store.close();
  });

  test("heading-only content (no body) still creates chunk", async () => {
    const { store } = await createStore();
    const result = await store.index({
      content: "# Title Only\n\n## Another Heading",
      source: "headings-only",
    });
    assert.ok(result.totalChunks >= 1);
    await store.close();
  });
});

describe("Source-Scoped Search", () => {
  test("search with source filter returns only matching source", async () => {
    const { store, indexName } = await createStore();
    await store.index({
      content: "# Zod Transform\n\nUse .transform() to map values.\n\n## Refine\n\nUse .refine() for custom validation.",
      source: "Zod API docs",
    });
    await store.index({
      content: "# Security Release\n\nCVE-2025-1234: Fixed transform injection vulnerability.\n\n## Fixes\n\nRefine permission checks.",
      source: "Node.js v22 CHANGELOG",
    });
    await refreshIndex(indexName);

    // Without source filter — both sources may match
    const allResults = await store.search("transform refine", 5, undefined, "OR");
    assert.ok(allResults.length >= 2, "Should find results from both sources");

    // With source filter — only Zod
    const zodResults = await store.search("transform refine", 5, "Zod", "OR");
    assert.ok(zodResults.length > 0, "Should find Zod results");
    assert.ok(
      zodResults.every((r) => r.source.includes("Zod")),
      `All results should be from Zod, got: ${zodResults.map((r) => r.source).join(", ")}`,
    );

    // With source filter — only Node.js
    const nodeResults = await store.search("transform refine", 5, "Node.js", "OR");
    assert.ok(nodeResults.length > 0, "Should find Node.js results");
    assert.ok(
      nodeResults.every((r) => r.source.includes("Node.js")),
      `All results should be from Node.js, got: ${nodeResults.map((r) => r.source).join(", ")}`,
    );

    await store.close();
  });

  test("search with non-matching source returns empty", async () => {
    const { store, indexName } = await createStore();
    await store.index({
      content: "# React Hooks\n\nuseEffect for side effects.",
      source: "React docs",
    });
    await refreshIndex(indexName);
    const results = await store.search("useEffect", 3, "Vue");
    assert.equal(results.length, 0, "Should return empty for non-matching source");
    await store.close();
  });

  test("listSources returns all indexed sources", async () => {
    const { store, indexName } = await createStore();
    await store.index({ content: "# A\n\nContent A.", source: "Source A" });
    await store.index({ content: "# B\n\nContent B.", source: "Source B" });
    await store.index({ content: "# C\n\nContent C.", source: "Source C" });
    await refreshIndex(indexName);

    const sources = await store.listSources();
    assert.equal(sources.length, 3, `Expected 3 sources, got ${sources.length}`);
    const labels = sources.map((s) => s.label);
    assert.ok(labels.includes("Source A"));
    assert.ok(labels.includes("Source B"));
    assert.ok(labels.includes("Source C"));
    assert.ok(sources.every((s) => s.chunkCount >= 1));
    await store.close();
  });

  test("source filter uses partial match (wildcard)", async () => {
    const { store, indexName } = await createStore();
    await store.index({ content: "# Config\n\nDatabase config.", source: "Node.js v22 CHANGELOG" });
    await store.index({ content: "# Config\n\nApp config.", source: "Zod API docs" });
    await refreshIndex(indexName);

    // Partial match "v22" should match "Node.js v22 CHANGELOG"
    const results = await store.search("config", 5, "v22");
    assert.ok(results.length > 0, "Partial source match should work");
    assert.ok(
      results.every((r) => r.source.includes("v22")),
      "Should only return v22 source",
    );
    await store.close();
  });
});

describe("Context Savings Measurement", () => {
  test("index+search uses less context than raw content", async () => {
    const { store, indexName } = await createStore();
    const content = readFileSync(
      join(fixtureDir, "context7-react-docs.md"),
      "utf-8",
    );
    const rawBytes = Buffer.byteLength(content);

    await store.index({ content, source: "React docs" });
    await refreshIndex(indexName);

    const results = await store.search("useEffect cleanup", 1);
    assert.ok(results.length > 0);

    const resultBytes = Buffer.byteLength(
      results.map((r) => `${r.title}\n${r.content}`).join("\n"),
    );
    assert.ok(
      resultBytes < rawBytes,
      "Search result should be smaller than full doc",
    );
    await store.close();
  });
});

describe("Plain Text Indexing", () => {
  test("indexPlainText: chunks by line groups", async () => {
    const { store } = await createStore();
    const lines = Array.from({ length: 100 }, (_, i) => `Log line ${i + 1}: processing request`).join("\n");
    const result = await store.indexPlainText(lines, "build-output");
    assert.ok(result.totalChunks >= 5, `Expected >=5 chunks for 100 lines with 20-line groups, got ${result.totalChunks}`);
    assert.equal(result.label, "build-output");
    assert.equal(result.codeChunks, 0);
    await store.close();
  });

  test("indexPlainText: single chunk for small output", async () => {
    const { store } = await createStore();
    const content = "Line 1\nLine 2\nLine 3";
    const result = await store.indexPlainText(content, "small-output");
    assert.equal(result.totalChunks, 1, `Expected 1 chunk for 3 lines, got ${result.totalChunks}`);
    assert.equal(result.label, "small-output");
    await store.close();
  });

  test("indexPlainText: blank-line splitting for sectioned output", async () => {
    const { store } = await createStore();
    const content = [
      "Section A line 1\nSection A line 2",
      "Section B line 1\nSection B line 2",
      "Section C line 1\nSection C line 2",
    ].join("\n\n");
    const result = await store.indexPlainText(content, "sectioned-output");
    assert.equal(result.totalChunks, 3, `Expected 3 chunks for 3 blank-line-separated sections, got ${result.totalChunks}`);
    await store.close();
  });

  test("indexPlainText: searchable after indexing", async () => {
    const { store, indexName } = await createStore();
    const lines = Array.from({ length: 200 }, (_, i) => {
      if (i === 149) return "ERROR: connection refused to database host";
      return `[INFO] ${i + 1}: normal operation continued`;
    }).join("\n");
    await store.indexPlainText(lines, "server-logs");
    await refreshIndex(indexName);
    const results = await store.search("connection refused", 3);
    assert.ok(results.length > 0, "Should find the error line via search");
    assert.ok(
      results[0].content.includes("connection refused"),
      `Result should contain 'connection refused', got: ${results[0].content.slice(0, 100)}`,
    );
    await store.close();
  });

  test("indexPlainText: empty content returns 0 chunks", async () => {
    const { store } = await createStore();
    const result = await store.indexPlainText("", "empty-output");
    assert.equal(result.totalChunks, 0, "Empty content should produce 0 chunks");
    assert.equal(result.label, "empty-output");
    await store.close();
  });

  test("indexPlainText: ES store works", async () => {
    const { store, indexName } = await createStore();
    const content = "Line 1\nLine 2\nLine 3";
    const result = await store.indexPlainText(content, "es-test");
    assert.equal(result.totalChunks, 1);
    assert.equal(result.label, "es-test");
    await refreshIndex(indexName);

    const searchResults = await store.search("Line 1", 1);
    assert.ok(searchResults.length > 0, "ES store should support search");
    assert.ok(searchResults[0].content.includes("Line 1"));
    await store.close();
  });
});

describe("getDistinctiveTerms", () => {
  test("getDistinctiveTerms: returns terms in moderate frequency range", async () => {
    const { store, indexName } = await createStore();
    const sections = Array.from({ length: 10 }, (_, i) => {
      const base = `## Section ${i}\n\nGeneric content for section number ${i}.`;
      if (i < 3) return `${base}\n\nThe authentication middleware validates tokens.`;
      if (i < 5) return `${base}\n\nThe database connection pool handles queries.`;
      return `${base}\n\nPlain filler paragraph without special keywords.`;
    }).join("\n\n");
    const result = await store.indexPlainText(sections, "distinctive-moderate");
    await refreshIndex(indexName);
    const terms = await store.getDistinctiveTerms("distinctive-moderate");
    assert.ok(Array.isArray(terms), "Should return an array");
    assert.ok(terms.length > 0, `Should return some distinctive terms, got ${terms.length}`);
    // "authentication" appears in 3/10 sections — should be distinctive
    assert.ok(
      terms.includes("authentication"),
      `Expected 'authentication' in distinctive terms, got: ${terms.join(", ")}`,
    );
    await store.close();
  });

  test("getDistinctiveTerms: returns empty for too few sections", async () => {
    const { store, indexName } = await createStore();
    const content = "Section A content here.\n\nSection B content here.";
    const result = await store.indexPlainText(content, "too-few-sections");
    await refreshIndex(indexName);
    assert.ok(result.totalChunks <= 2, `Expected <=2 chunks, got ${result.totalChunks}`);
    const terms = await store.getDistinctiveTerms("too-few-sections");
    assert.deepEqual(terms, [], "Should return empty array for fewer than 3 chunks");
    await store.close();
  });

  test("getDistinctiveTerms: excludes stopwords", async () => {
    const { store, indexName } = await createStore();
    const sections = Array.from({ length: 5 }, (_, i) => {
      const base = `## Part ${i}\n\nThis is the content that comes with part number ${i}.`;
      if (i < 2) return `${base}\n\nEncryption algorithms protect the data.`;
      return base;
    }).join("\n\n");
    const result = await store.indexPlainText(sections, "stopwords-test");
    await refreshIndex(indexName);
    const terms = await store.getDistinctiveTerms("stopwords-test");
    const stopwords = ["the", "this", "that", "with", "for", "and"];
    for (const sw of stopwords) {
      assert.ok(
        !terms.includes(sw),
        `Stopword '${sw}' should not be in distinctive terms`,
      );
    }
    // "encryption" appears in 2/5 sections — should qualify
    assert.ok(
      terms.includes("encryption"),
      `Expected 'encryption' in terms, got: ${terms.join(", ")}`,
    );
    await store.close();
  });
});

describe("Smart Chunk Titles", () => {
  test("smart chunk titles: blank-line split uses first line as title", async () => {
    const { store, indexName } = await createStore();
    const content = [
      "v2.3.0 - Performance improvements\nFixed memory leak in connection pool\nReduced startup time by 40%",
      "v2.2.1 - Security patch\nPatched XSS vulnerability in template engine\nUpdated dependencies",
      "v2.2.0 - New features\nAdded WebSocket support\nNew configuration API",
      "v2.1.0 - Bug fixes\nFixed race condition in worker threads\nImproved error messages",
    ].join("\n\n");
    await store.indexPlainText(content, "changelog-sections");
    await refreshIndex(indexName);

    const results = await store.search("memory leak connection pool", 1);
    assert.ok(results.length > 0, "Should find the section");
    assert.ok(
      results[0].title.startsWith("v2.3.0"),
      `Title should be first line 'v2.3.0 - Performance improvements', got: '${results[0].title}'`,
    );
    assert.ok(
      !results[0].title.startsWith("Section"),
      `Title should not be generic 'Section N', got: '${results[0].title}'`,
    );

    const results2 = await store.search("XSS vulnerability template", 1);
    assert.ok(results2.length > 0, "Should find second section");
    assert.ok(
      results2[0].title.startsWith("v2.2.1"),
      `Title should be 'v2.2.1 - Security patch', got: '${results2[0].title}'`,
    );
    await store.close();
  });

  test("smart chunk titles: line-group chunks use first line as title", async () => {
    const { store, indexName } = await createStore();
    const lines = Array.from({ length: 60 }, (_, i) => {
      if (i === 0) return "ERROR: Failed to compile module 'auth-service'";
      if (i === 20) return "WARNING: Deprecated API usage in routes/v2.ts";
      if (i === 40) return "INFO: Build completed with 2 warnings";
      return `[LOG] Step ${i}: processing task ${i}`;
    });
    const content = lines.join("\n");
    await store.indexPlainText(content, "build-log");
    await refreshIndex(indexName);

    const results = await store.search("Failed compile auth-service", 1);
    assert.ok(results.length > 0, "Should find the first chunk");
    assert.ok(
      results[0].title.includes("ERROR"),
      `Title should be first line of chunk containing 'ERROR', got: '${results[0].title}'`,
    );
    assert.ok(
      !results[0].title.startsWith("Lines"),
      `Title should not be generic 'Lines N-M', got: '${results[0].title}'`,
    );
    await store.close();
  });
});

describe("Index Cleanup", () => {
  test("cleanupStaleIndices is a no-op (returns 0)", () => {
    // ES indices are not PID-scoped temp files — cleanup is a no-op stub
    const cleaned = cleanupStaleIndices();
    assert.equal(cleaned, 0, "cleanupStaleIndices should return 0");
  });

  test("store.cleanup() deletes the index", async () => {
    const { store, indexName } = await createStore();
    await store.index({ content: "# Test\n\nCleanup test content.", source: "cleanup-test" });

    await store.cleanup();
    // After cleanup, the index should be gone — remove from our cleanup list
    cleanups.pop();
  });

  test("store.cleanup() is safe to call multiple times", async () => {
    const { store, indexName } = await createStore();
    await store.cleanup();
    await store.cleanup(); // should not throw
    cleanups.pop();
  });
});

describe("Max Chunk Size", () => {
  test("splits oversized markdown chunk at paragraph boundaries", async () => {
    const { store, indexName } = await createStore();
    const paragraphs = Array.from({ length: 20 }, (_, i) =>
      `Paragraph ${i + 1}. ${"Lorem ipsum dolor sit amet. ".repeat(20)}`
    );
    const content = `# Big Section\n\n${paragraphs.join("\n\n")}`;

    const result = await store.index({ content, source: "max-chunk-test" });
    assert.ok(result.totalChunks > 1, `Expected >1 chunk, got ${result.totalChunks}`);
    await refreshIndex(indexName);

    const searchResult = await store.search("Paragraph", 10, "max-chunk-test");
    for (const r of searchResult) {
      assert.ok(r.title.includes("Big Section"), `Expected heading in title, got: ${r.title}`);
    }
    await store.close();
  });

  test("does not split chunks already under maxChunkBytes", async () => {
    const { store } = await createStore();
    const content = `# Small Section\n\nJust a few lines of text.\n\nAnother paragraph.`;
    const result = await store.index({ content, source: "small-chunk-test" });
    assert.equal(result.totalChunks, 1);
    await store.close();
  });

  test("keeps code blocks intact when splitting oversized chunks", async () => {
    const { store, indexName } = await createStore();
    const codeBlock = "```typescript\n" + "const x = 1;\n".repeat(100) + "```";
    const prose = Array.from({ length: 10 }, (_, i) =>
      `Paragraph ${i}. ${"Text content here. ".repeat(20)}`
    ).join("\n\n");
    const content = `# Code Section\n\n${codeBlock}\n\n${prose}`;

    const result = await store.index({ content, source: "code-chunk-test" });
    assert.ok(result.totalChunks >= 2, `Expected >=2 chunks, got ${result.totalChunks}`);
    await refreshIndex(indexName);

    const codeResults = await store.search("const x", 5, "code-chunk-test");
    assert.ok(codeResults.length > 0, "Should find the code block");
    assert.ok(
      codeResults[0].content.includes("```typescript"),
      "Code block should be intact with opening fence",
    );
    await store.close();
  });
});

describe("JSON Chunking (Objects)", () => {
  test("chunks JSON object by top-level keys", async () => {
    const { store, indexName } = await createStore();
    const json = JSON.stringify({
      authentication: {
        oauth: { clientId: "abc", scopes: ["read", "write"] },
        jwt: { algorithm: "RS256", expiry: "1h" },
      },
      database: {
        host: "localhost",
        port: 5432,
      },
    });

    const result = await store.indexJSON(json, "config");
    assert.ok(result.totalChunks >= 2, `Expected >=2 chunks, got ${result.totalChunks}`);
    await refreshIndex(indexName);

    const authResults = await store.search("oauth clientId", 5, "config");
    assert.ok(authResults.length > 0, "Should find oauth config");
    assert.ok(
      authResults[0].title.includes("authentication"),
      `Expected 'authentication' in title, got: ${authResults[0].title}`,
    );
    await store.close();
  });

  test("small JSON object becomes single chunk", async () => {
    const { store } = await createStore();
    const json = JSON.stringify({ name: "Alice", role: "admin" });
    const result = await store.indexJSON(json, "small");
    assert.equal(result.totalChunks, 1);
    await store.close();
  });

  test("chunks nested JSON with path titles", async () => {
    const { store, indexName } = await createStore();
    const endpoints: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) {
      endpoints[`/api/v1/resource${i}`] = {
        method: "GET",
        description: `Get resource ${i}. ${"Details. ".repeat(50)}`,
        params: { id: "string", limit: "number" },
      };
    }
    const json = JSON.stringify({ endpoints });

    const result = await store.indexJSON(json, "api-spec");
    assert.ok(result.totalChunks > 1, `Expected >1 chunk, got ${result.totalChunks}`);
    await refreshIndex(indexName);

    const results = await store.search("resource15", 5, "api-spec");
    assert.ok(results.length > 0, "Should find resource15");
    await store.close();
  });

  test("handles invalid JSON gracefully by falling back to plain text", async () => {
    const { store } = await createStore();
    const result = await store.indexJSON("not valid json {{{", "bad-json");
    assert.ok(result.totalChunks >= 1, "Should still index as plain text");
    await store.close();
  });
});

describe("JSON Chunking (Arrays)", () => {
  test("top-level array of objects uses identity field in titles", async () => {
    const { store, indexName } = await createStore();
    const users = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      name: `User ${i + 1}`,
      email: `user${i + 1}@example.com`,
      bio: `Bio for user ${i + 1}. ${"Some details. ".repeat(10)}`,
    }));
    const json = JSON.stringify(users);

    const result = await store.indexJSON(json, "users-api");
    assert.ok(result.totalChunks > 1, `Expected >1 chunk, got ${result.totalChunks}`);
    await refreshIndex(indexName);

    const results = await store.search("User 25", 5, "users-api");
    assert.ok(results.length > 0, "Should find User 25");
    await store.close();
  });

  test("identity field appears in chunk titles", async () => {
    const { store, indexName } = await createStore();
    const items = [
      { name: "Alice", role: "admin", data: "x".repeat(2000) },
      { name: "Bob", role: "user", data: "y".repeat(2000) },
      { name: "Carol", role: "user", data: "z".repeat(2000) },
    ];
    const json = JSON.stringify(items);

    const result = await store.indexJSON(json, "people");
    assert.ok(result.totalChunks >= 2, `Expected >=2 chunks, got ${result.totalChunks}`);
    await refreshIndex(indexName);

    const results = await store.search("Alice admin", 5, "people");
    assert.ok(results.length > 0, "Should find Alice");
    assert.ok(
      results[0].title.includes("Alice"),
      `Expected 'Alice' in title, got: ${results[0].title}`,
    );
    await store.close();
  });

  test("array of primitives becomes batched chunks", async () => {
    const { store } = await createStore();
    const longStrings = Array.from({ length: 100 }, (_, i) =>
      `Item ${i}: ${"content ".repeat(50)}`
    );
    const json = JSON.stringify(longStrings);

    const result = await store.indexJSON(json, "primitives");
    assert.ok(result.totalChunks >= 2, `Expected >=2 chunks, got ${result.totalChunks}`);
    await store.close();
  });

  test("nested array within object uses full key path", async () => {
    const { store, indexName } = await createStore();
    const json = JSON.stringify({
      api: {
        endpoints: Array.from({ length: 20 }, (_, i) => ({
          path: `/api/v1/resource${i}`,
          method: "GET",
          description: `Resource ${i}. ${"Details ".repeat(30)}`,
        })),
      },
    });

    const result = await store.indexJSON(json, "nested-api");
    assert.ok(result.totalChunks > 1, `Expected >1 chunk, got ${result.totalChunks}`);
    await refreshIndex(indexName);

    const results = await store.search("resource10", 5, "nested-api");
    assert.ok(results.length > 0, "Should find resource10");
    assert.ok(
      results[0].title.includes("api") && results[0].title.includes("endpoints"),
      `Expected path in title, got: ${results[0].title}`,
    );
    await store.close();
  });
});

describe("Content-Type Routing", () => {
  test("indexJSON produces searchable chunks from pretty-printed JSON", async () => {
    const { store, indexName } = await createStore();
    const apiResponse = JSON.stringify({
      data: {
        users: [
          { id: 1, name: "Alice", email: "alice@example.com" },
          { id: 2, name: "Bob", email: "bob@example.com" },
        ],
        pagination: { page: 1, total: 100 },
      },
    });

    const result = await store.indexJSON(apiResponse, "api-response");
    assert.ok(result.totalChunks >= 1, `Expected >=1 chunks, got ${result.totalChunks}`);
    await refreshIndex(indexName);

    const results = await store.search("Alice email", 5, "api-response");
    assert.ok(results.length > 0, "Should find Alice's email via search");
    await store.close();
  });

  test("indexPlainText handles non-JSON non-HTML content", async () => {
    const { store } = await createStore();
    const plainText = "name,email,role\nAlice,alice@example.com,admin\nBob,bob@example.com,user";
    const result = await store.indexPlainText(plainText, "csv-response");
    assert.ok(result.totalChunks >= 1);
    await store.close();
  });
});
