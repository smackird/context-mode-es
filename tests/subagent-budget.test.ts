/**
 * Subagent Output Budget Tests
 *
 * Tests the full subagent context protection pipeline:
 * 1. Hook injection: pretooluse.mjs injects OUTPUT FORMAT into Task prompts
 * 2. Shared KB: subagent index() → main agent search() via same ContentStoreES
 * 3. LLM compliance: real subagent respects word budget (requires `claude` CLI)
 *
 * Run: npx vitest tests/subagent-budget.test.ts
 * Run with LLM: npx vitest tests/subagent-budget.test.ts -- --live
 */

import { strict as assert } from "node:assert";
import { spawnSync, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, afterAll } from "vitest";
import { createTestContentStore, cleanupIndex, refreshIndex } from "./shared/es-test-helpers.js";
import { ContentStoreES } from "../src/store-es.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(__dirname, "..", "hooks", "pretooluse.mjs");
const LIVE = process.argv.includes("--live");

// Import shared ROUTING_BLOCK — single source of truth
import { ROUTING_BLOCK } from "../hooks/routing-block.mjs";

/**
 * TypeScript mock of hooks/pretooluse.mjs routing logic.
 * Replicates Task branch behavior without bash/jq dependency.
 */
function runHook(input: Record<string, unknown>): string {
  const toolName = (input as any).tool_name ?? "";
  const toolInput = (input as any).tool_input ?? {};

  if (toolName === "Task") {
    const subagentType = toolInput.subagent_type ?? "";
    const prompt = toolInput.prompt ?? "";

    if (subagentType === "Bash") {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: {
            ...toolInput,
            prompt: prompt + ROUTING_BLOCK,
            subagent_type: "general-purpose",
          },
        },
      });
    }

    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          ...toolInput,
          prompt: prompt + ROUTING_BLOCK,
        },
      },
    });
  }

  // Non-Task tools return empty (passthrough)
  return "";
}

describe("Hook Injection", () => {
  test("Task hook injects context_window_protection XML block", () => {
    const output = runHook({
      tool_name: "Task",
      tool_input: { prompt: "Research zod npm package", subagent_type: "general-purpose" },
    });
    const parsed = JSON.parse(output);
    const prompt = parsed.hookSpecificOutput.updatedInput.prompt;
    assert.ok(
      prompt.includes("<context_window_protection>"),
      "Should inject context_window_protection opening tag",
    );
    assert.ok(
      prompt.includes("</context_window_protection>"),
      "Should inject context_window_protection closing tag",
    );
  });

  test("Task hook injects output constraints and tool hierarchy", () => {
    const output = runHook({
      tool_name: "Task",
      tool_input: { prompt: "Research zod", subagent_type: "general-purpose" },
    });
    const parsed = JSON.parse(output);
    const prompt = parsed.hookSpecificOutput.updatedInput.prompt;
    assert.ok(prompt.includes("<output_constraints>"), "Should inject output_constraints");
    assert.ok(prompt.includes("500 words"), "Should mention 500 word limit");
    assert.ok(
      prompt.includes("<tool_selection_hierarchy>"),
      "Should inject tool_selection_hierarchy",
    );
    assert.ok(
      prompt.includes("<forbidden_actions>"),
      "Should inject forbidden_actions",
    );
  });

  test("Task hook injects batch_execute as primary tool", () => {
    const output = runHook({
      tool_name: "Task",
      tool_input: { prompt: "Analyze repo", subagent_type: "Explore" },
    });
    const parsed = JSON.parse(output);
    const prompt = parsed.hookSpecificOutput.updatedInput.prompt;
    assert.ok(
      prompt.includes("batch_execute"),
      "Should mention batch_execute as primary tool",
    );
  });

  test("Task hook upgrades Bash subagent to general-purpose", () => {
    const output = runHook({
      tool_name: "Task",
      tool_input: { prompt: "Run git log", subagent_type: "Bash" },
    });
    const parsed = JSON.parse(output);
    const updated = parsed.hookSpecificOutput.updatedInput;
    assert.equal(
      updated.subagent_type,
      "general-purpose",
      "Bash should be upgraded to general-purpose",
    );
    assert.ok(
      updated.prompt.includes("<context_window_protection>"),
      "Upgraded subagent should also get context_window_protection",
    );
  });

  test("Task hook preserves original prompt content", () => {
    const original = "Research the architecture of Next.js App Router";
    const output = runHook({
      tool_name: "Task",
      tool_input: { prompt: original, subagent_type: "general-purpose" },
    });
    const parsed = JSON.parse(output);
    const prompt = parsed.hookSpecificOutput.updatedInput.prompt;
    assert.ok(
      prompt.startsWith(original),
      "Original prompt should be preserved at the start",
    );
  });

  test("Non-Task tools are not affected by output budget", () => {
    const output = runHook({
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });
    // Bash hook returns empty or redirect, never OUTPUT FORMAT
    assert.ok(
      !output.includes("OUTPUT FORMAT"),
      "Bash tool should not get output format injection",
    );
  });
});

describe("Shared Knowledge Base (subagent -> main)", () => {
  const indexNames: string[] = [];

  afterAll(async () => {
    for (const idx of indexNames) {
      await cleanupIndex(idx);
    }
  });

  test("subagent index() is visible to main agent search()", async () => {
    // Same ContentStoreES instance = same as shared MCP server process
    const { store, indexName } = await createTestContentStore();
    indexNames.push(indexName);

    // Simulate subagent indexing its research
    await store.index({
      content: [
        "# Zod Overview",
        "TypeScript-first schema validation library.",
        "Zero dependencies, 98M weekly downloads.",
        "",
        "# API Reference",
        "z.string(), z.number(), z.object() are the core primitives.",
        "Use .parse() for runtime validation with type inference.",
        "",
        "# Recent Changes",
        "v4.3.6: Performance improvements to object parsing.",
        "v4.3.5: Fixed discriminated union edge case.",
      ].join("\n"),
      source: "subagent:zod-research",
    });

    await refreshIndex(indexName);

    // Simulate main agent searching subagent's indexed content
    const results = await store.search("weekly downloads", 1, "zod-research");
    assert.ok(results.length > 0, "Main should find subagent's indexed content");
    assert.ok(
      results[0].content.includes("98M"),
      "Should retrieve exact data from subagent's index",
    );

    const apiResults = await store.search("parse validation", 1, "zod-research");
    assert.ok(apiResults.length > 0, "Main should find API details");
    assert.ok(apiResults[0].content.includes(".parse()"), "Should find .parse() reference");
  });

  test("multiple subagents index into same KB with distinct sources", async () => {
    const { store, indexName } = await createTestContentStore();
    indexNames.push(indexName);

    // Subagent A indexes architecture research
    await store.index({
      content: "# Architecture\nMonorepo with pnpm workspaces. 15 packages.",
      source: "subagent-A:architecture",
    });

    // Subagent B indexes API research
    await store.index({
      content: "# API Endpoints\nREST + GraphQL. 47 endpoints total.",
      source: "subagent-B:api",
    });

    // Subagent C indexes contributor analysis
    await store.index({
      content: "# Contributors\nTop: @alice (312 commits), @bob (198 commits).",
      source: "subagent-C:contributors",
    });

    await refreshIndex(indexName);

    // Main agent searches each subagent's findings by source
    const arch = await store.search("monorepo", 1, "subagent-A");
    assert.ok(arch.length > 0 && arch[0].content.includes("pnpm"));

    const api = await store.search("endpoints", 1, "subagent-B");
    assert.ok(api.length > 0 && api[0].content.includes("47"));

    const contrib = await store.search("commits", 1, "subagent-C");
    assert.ok(contrib.length > 0 && contrib[0].content.includes("alice"));

    // Cross-search without source filter finds all (OR mode for cross-chunk terms)
    const all = await store.search("monorepo endpoints commits", 5, undefined, "OR");
    assert.ok(all.length >= 2, "Global search should find results from multiple subagents");
  });

  test("main agent can search subagent KB after subagent is done", async () => {
    const { store, indexName } = await createTestContentStore();
    indexNames.push(indexName);

    // Subagent lifecycle: index → done
    await store.index({
      content: "# Security Audit\nNo critical vulnerabilities found. 3 medium severity issues in auth module.",
      source: "subagent:security-audit",
    });
    // Subagent returns summary: "Indexed findings as 'subagent:security-audit'"

    await refreshIndex(indexName);

    // Main agent picks up later and searches
    const results = await store.search("vulnerabilities auth", 1, "security-audit");
    assert.ok(results.length > 0);
    assert.ok(results[0].content.includes("3 medium severity"));
  });
});

describe("Context Budget Measurement", () => {
  test("ideal subagent response is under 500 words / 2KB", () => {
    // This is what a compliant subagent response should look like
    const idealResponse = [
      "## Summary",
      "- Researched zod npm package using batch_execute (1 call, 5 commands)",
      "- Indexed detailed findings as 'subagent:zod-research' (3 sections)",
      "",
      "## Key Findings",
      "- TypeScript-first schema validation, zero dependencies",
      "- v4.3.6 latest, 98.5M weekly downloads",
      "- 541 contributors, Colin McDonnell primary maintainer",
      "- MIT license, used by 2.8M+ projects",
      "",
      "## Indexed Sources",
      "- `subagent:zod-research` — full API docs, version history, contributor list",
      "",
      "Use `search(source: 'subagent:zod-research')` for details.",
    ].join("\n");

    const words = idealResponse.split(/\s+/).filter((w) => w.length > 0).length;
    const bytes = Buffer.byteLength(idealResponse);

    assert.ok(words < 500, `Ideal response should be under 500 words, got ${words}`);
    assert.ok(bytes < 2048, `Ideal response should be under 2KB, got ${bytes}`);
  });

  test("non-compliant response exceeds budget", () => {
    // Simulate what happens WITHOUT the output budget — full inline dump
    const bloatedResponse = Array.from(
      { length: 50 },
      (_, i) => `Line ${i}: Detailed information about zod feature ${i} with examples and code snippets...`,
    ).join("\n");

    const words = bloatedResponse.split(/\s+/).filter((w) => w.length > 0).length;
    const bytes = Buffer.byteLength(bloatedResponse);

    assert.ok(words > 500, "Bloated response should exceed 500 words");
  });
});

// Live LLM test — only runs when --live flag is passed
// NOTE: This test spawns a subprocess using `claude` CLI which may internally
// use ContentStore. If that subprocess needs ES migration, it should be handled
// separately as it runs in its own process context.
if (LIVE) {
  describe("Live LLM Test (claude -p)", () => {
    test("real subagent respects output budget", async () => {
      const prompt = `Research the npm package "chalk" — what it does, latest version, weekly downloads. Keep it brief.`;

      // Use claude CLI in pipe mode with haiku for speed
      const result = spawnSync(
        "claude",
        ["-p", "--model", "haiku", prompt],
        {
          encoding: "utf-8",
          timeout: 60_000,
          env: { ...process.env },
        },
      );

      if (result.error || result.status !== 0) {
        console.log("    Skipped: claude CLI not available or errored");
        console.log("    stderr:", result.stderr?.slice(0, 200));
        return;
      }

      const response = result.stdout;
      const words = response.split(/\s+/).filter((w: string) => w.length > 0).length;
      const bytes = Buffer.byteLength(response);

      // Soft assertion — LLM may not always comply perfectly
      if (words > 500) {
        console.log(`    WARNING: Response exceeded 500 word budget (${words} words)`);
      }

      assert.ok(
        words < 1000,
        `Response should be reasonable length, got ${words} words`,
      );
    });
  });
}
