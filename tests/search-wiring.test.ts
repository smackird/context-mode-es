/**
 * PR #4 QA Verification Tests
 *
 * Regression tests verifying the bugs fixed in PR #4:
 *   1. searchWithFallback was implemented but never wired into server.ts code paths
 *   2. Ephemeral ContentStore(":memory:") in intentSearch duplicated work
 *   3. batch_execute Tier 2 "boosted with all section titles" was indiscriminate
 *   4. Vocabulary insertion lacked transaction wrapping (perf issue)
 *   5. getDistinctiveTerms used .all() loading all chunks into memory
 *
 * These tests focus on store-level behavior to prove correctness of each fix.
 *
 * Migrated to ContentStoreES (Elasticsearch 9.3).
 */

import { describe, test, expect, afterAll } from "vitest";
import { strict as assert } from "node:assert";
import { createTestContentStore, cleanupIndex, refreshIndex } from "./shared/es-test-helpers.js";
import { ContentStoreES } from "../src/store-es.js";

describe("Fix 1: searchWithFallback cascade on persistent store", () => {
  const indexes: string[] = [];

  afterAll(async () => {
    for (const idx of indexes) {
      await cleanupIndex(idx);
    }
  });

  test("searchWithFallback: porter layer returns results with matchLayer='porter'", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    await store.indexPlainText(
      "The authentication middleware validates JWT tokens on every request.\nExpired tokens are rejected with 401.",
      "execute:shell",
    );
    await refreshIndex(indexName);

    const results = await store.searchWithFallback("authentication JWT tokens", 3, "execute:shell");
    assert.ok(results.length > 0, "Porter should find exact terms");
    assert.equal(results[0].matchLayer, "porter", "matchLayer should be 'porter'");
    assert.ok(results[0].content.includes("JWT"), "Content should contain JWT");

    await store.close();
  });

  test("searchWithFallback: fuzzy/trigram layer activates when porter fails", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    await store.indexPlainText(
      "The responseBodyParser transforms incoming XML payloads into JSON.\nAll endpoints accept application/xml.",
      "execute:shell",
    );
    await refreshIndex(indexName);

    // "responseBody" is a substring of "responseBodyParser" — porter won't match,
    // ES searchWithFallback cascade: porter -> fuzzy -> trigram
    const results = await store.searchWithFallback("responseBody", 3, "execute:shell");
    assert.ok(results.length > 0, "Fuzzy or trigram should find substring match");
    // In ES, the cascade is porter -> fuzzy -> trigram (3 attempts)
    assert.ok(
      results[0].matchLayer === "fuzzy" || results[0].matchLayer === "trigram",
      `matchLayer should be 'fuzzy' or 'trigram', got '${results[0].matchLayer}'`,
    );

    await store.close();
  });

  test("searchWithFallback: fuzzy layer corrects misspellings", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    await store.indexPlainText(
      "PostgreSQL database connection established successfully.\nConnection pool size: 10.",
      "execute:shell",
    );
    await refreshIndex(indexName);

    // "databse" is a typo for "database" — ES fuzzy search handles this
    const results = await store.searchWithFallback("databse", 3, "execute:shell");
    assert.ok(results.length > 0, "Fuzzy should correct 'databse' to 'database'");
    // In ES cascade: porter -> fuzzy -> trigram; typo correction is via fuzzy layer
    assert.ok(
      results[0].matchLayer === "fuzzy" || results[0].matchLayer === "trigram",
      `matchLayer should be 'fuzzy' or 'trigram', got '${results[0].matchLayer}'`,
    );
    assert.ok(results[0].content.toLowerCase().includes("database"), "Content should have 'database'");

    await store.close();
  });

  test("searchWithFallback: cascade stops at first successful layer", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    await store.indexPlainText(
      "Redis cache hit rate: 95%\nMemcached fallback rate: 3%",
      "execute:shell",
    );
    await refreshIndex(indexName);

    // "redis" is an exact term — should stop at porter, never try fuzzy/trigram
    const results = await store.searchWithFallback("redis cache", 3, "execute:shell");
    assert.ok(results.length > 0, "Should find results");
    assert.equal(results[0].matchLayer, "porter", "Should stop at porter when it succeeds");

    await store.close();
  });

  test("searchWithFallback: returns empty array when all layers fail", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    await store.indexPlainText(
      "Server listening on port 8080\nHealth check endpoint ready",
      "execute:shell",
    );
    await refreshIndex(indexName);

    // Completely unrelated terms that no layer can match
    const results = await store.searchWithFallback("xylophoneZebraQuartz", 3, "execute:shell");
    assert.equal(results.length, 0, "Should return empty when nothing matches");

    await store.close();
  });
});

describe("Fix 2: persistent store replaces ephemeral DB correctly", () => {
  const indexes: string[] = [];

  afterAll(async () => {
    for (const idx of indexes) {
      await cleanupIndex(idx);
    }
  });

  test("persistent store with source scoping isolates results like ephemeral DB did", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    // Simulate two consecutive intentSearch calls indexing different outputs
    await store.indexPlainText(
      "FAIL: test/auth.test.ts - Expected 200 but got 401\nTimeout in token refresh",
      "execute:typescript:error",
    );
    await store.indexPlainText(
      "PASS: all 50 integration tests passed\n0 failures, 0 skipped, 50 total",
      "execute:shell",
    );
    await refreshIndex(indexName);

    // Scoped search for the error source should only return error content
    const errorResults = await store.searchWithFallback("401 timeout", 3, "execute:typescript:error");
    assert.ok(errorResults.length > 0, "Should find error content");
    assert.ok(
      errorResults.every(r => r.source.includes("error")),
      "All results should be from the error source",
    );

    // Scoped search for the success source should only return success content
    const successResults = await store.searchWithFallback("tests passed", 3, "execute:shell");
    assert.ok(successResults.length > 0, "Should find success content");
    assert.ok(
      successResults.every(r => r.source.includes("shell")),
      "All results should be from the shell source",
    );

    await store.close();
  });

  test("persistent store accumulates content across multiple indexPlainText calls", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    await store.indexPlainText("Error log from first command", "cmd-1");
    await store.indexPlainText("Error log from second command", "cmd-2");
    await store.indexPlainText("Error log from third command", "cmd-3");
    await refreshIndex(indexName);

    // Global search (no source filter) should find content from all sources
    const allResults = await store.searchWithFallback("error log", 10);
    assert.ok(allResults.length >= 3, `Should find content from all 3 sources, got ${allResults.length}`);

    // Source-scoped search should be precise
    const cmd2Only = await store.searchWithFallback("error log", 3, "cmd-2");
    assert.ok(cmd2Only.length > 0, "Should find cmd-2 results");
    assert.ok(
      cmd2Only.every(r => r.source.includes("cmd-2")),
      "Scoped results should only be from cmd-2",
    );

    await store.close();
  });
});

describe("Fix 3: batch_execute search precision (no indiscriminate boosting)", () => {
  const indexes: string[] = [];

  afterAll(async () => {
    for (const idx of indexes) {
      await cleanupIndex(idx);
    }
  });

  test("searchWithFallback returns only relevant results, not everything", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    // Simulate batch_execute with multiple command outputs indexed
    await store.index({
      content: "# Git Log\n\ncommit abc123\nAuthor: dev@example.com\nFix memory leak in WebSocket handler",
      source: "batch:git-log",
    });
    await store.index({
      content: "# Disk Usage\n\n/dev/sda1: 45% used\n/dev/sdb1: 89% used — WARNING",
      source: "batch:df",
    });
    await store.index({
      content: "# Network Stats\n\neth0: 1.2Gbps RX, 800Mbps TX\nPacket loss: 0.01%",
      source: "batch:netstat",
    });
    await refreshIndex(indexName);

    // Query for "memory leak" should return git log, NOT disk usage or network
    const results = await store.searchWithFallback("memory leak WebSocket", 3);
    assert.ok(results.length > 0, "Should find git log content");
    assert.ok(
      results[0].content.includes("memory leak") || results[0].content.includes("WebSocket"),
      "First result should be about memory leak",
    );
    // The old boosted approach would return ALL sections; searchWithFallback
    // should be precise and only return the relevant one
    assert.ok(
      !results.some(r => r.content.includes("Packet loss")),
      "Network stats should NOT appear in memory leak results",
    );

    await store.close();
  });

  test("searchWithFallback with source scoping is more precise than global", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    await store.index({
      content: "# Build Output\n\nCompiled 42 TypeScript files\nBundle: 256KB gzipped",
      source: "batch:build",
    });
    await store.index({
      content: "# Test Output\n\n42 tests passed, 0 failed\nCoverage: 91.5%",
      source: "batch:test",
    });
    await refreshIndex(indexName);

    // Scoped search for "42" should return only the matching source
    const buildResults = await store.searchWithFallback("TypeScript files compiled", 3, "batch:build");
    assert.ok(buildResults.length > 0, "Should find build output");
    assert.ok(
      buildResults.every(r => r.source.includes("build")),
      "All results should be from build source",
    );

    const testResults = await store.searchWithFallback("tests passed coverage", 3, "batch:test");
    assert.ok(testResults.length > 0, "Should find test output");
    assert.ok(
      testResults.every(r => r.source.includes("test")),
      "All results should be from test source",
    );

    await store.close();
  });
});

describe("Fix 4: vocabulary / fuzzy correction", () => {
  // ContentStoreES has no vocab table — fuzzyCorrect() always returns null.
  // These tests verify the stub behavior and that indexing large content doesn't throw.

  const indexes: string[] = [];

  afterAll(async () => {
    for (const idx of indexes) {
      await cleanupIndex(idx);
    }
  });

  test("fuzzyCorrect always returns null in ContentStoreES (no vocab table)", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    // Index content with distinctive words
    await store.index({
      content: "# Microservices\n\nThe containerized orchestration platform manages deployments.\n\n" +
        "# Monitoring\n\nPrometheus collects containerized metrics from orchestration layer.\n\n" +
        "# Scaling\n\nHorizontal pod autoscaling uses containerized orchestration policies.",
      source: "k8s-docs",
    });
    await refreshIndex(indexName);

    // fuzzyCorrect in ContentStoreES always returns null — no vocab table
    const correction = store.fuzzyCorrect("orchestraton"); // typo for "orchestration"
    assert.equal(
      correction,
      null,
      "ContentStoreES.fuzzyCorrect always returns null (no vocab table)",
    );

    await store.close();
  });

  test("large content indexing does not throw", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    // Generate content with many unique words
    const sections = Array.from({ length: 50 }, (_, i) => {
      const uniqueWord = `customVariable${i}Value`;
      return `## Section ${i}\n\n${uniqueWord} is used in module${i} for processing data${i}.`;
    }).join("\n\n");

    // Should not throw
    await store.index({ content: sections, source: "large-vocab" });
    await refreshIndex(indexName);

    // fuzzyCorrect always returns null in ES — just verify it doesn't throw
    const correction = store.fuzzyCorrect("customvariable1valu");
    assert.equal(
      correction,
      null,
      "ContentStoreES.fuzzyCorrect always returns null",
    );

    await store.close();
  });
});

describe("Fix 5: getDistinctiveTerms", () => {
  const indexes: string[] = [];

  afterAll(async () => {
    for (const idx of indexes) {
      await cleanupIndex(idx);
    }
  });

  test("getDistinctiveTerms produces correct terms", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    // Create content with known word frequency patterns
    const indexed = await store.index({
      content: [
        "# Module A",
        "",
        "The serialization framework handles JSON transformation efficiently.",
        "Serialization is critical for API responses.",
        "",
        "# Module B",
        "",
        "The serialization layer converts protocol buffers.",
        "Performance benchmarks show fast serialization.",
        "",
        "# Module C",
        "",
        "Custom serialization handlers extend the base framework.",
        "Unit tests cover serialization edge cases.",
        "",
        "# Module D",
        "",
        "Documentation for the serialization API reference.",
        "Migration guide from v1 serialization format.",
      ].join("\n"),
      source: "serialization-docs",
    });
    await refreshIndex(indexName);

    // ES uses sourceLabel (string) instead of sourceId (number)
    const terms = await store.getDistinctiveTerms(indexed.label);
    assert.ok(Array.isArray(terms), "Should return an array");
    assert.ok(terms.length > 0, `Should find distinctive terms, got ${terms.length}`);

    // Verify no duplicates
    const uniqueTerms = new Set(terms);
    assert.equal(uniqueTerms.size, terms.length, "Terms should have no duplicates");

    // All terms should be >= 3 chars and not stopwords
    for (const term of terms) {
      assert.ok(term.length >= 3, `Term '${term}' should be >= 3 chars`);
    }

    await store.close();
  });

  test("getDistinctiveTerms returns empty for sources with < 3 chunks", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    const indexed = await store.index({
      content: "# Single Section\n\nThis document has only one section with some content.",
      source: "tiny-doc",
    });
    await refreshIndex(indexName);

    // ES uses sourceLabel (string) instead of sourceId (number)
    const terms = await store.getDistinctiveTerms(indexed.label);
    assert.deepEqual(terms, [], "Should return empty for documents with < 3 chunks");

    await store.close();
  });

  test("getDistinctiveTerms filters terms outside frequency band", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    // 10 chunks: minAppearances=2, maxAppearances=max(3, ceil(10*0.4))=4
    const indexed = await store.index({
      content: Array.from({ length: 10 }, (_, i) => {
        let section = `# Section ${i}\n\nGeneric content for section number ${i} with filler text.`;
        // "elasticsearch" appears in exactly 3 sections (within 2-4 band)
        if (i >= 2 && i <= 4) section += "\nElasticsearch cluster rebalancing in progress.";
        // "ubiquitous" appears in all 10 sections (above maxAppearances=4)
        section += "\nThe ubiquitous logging framework captures all events.";
        // "singleton" appears in exactly 1 section (below minAppearances=2)
        if (i === 7) section += "\nSingleton pattern used for configuration.";
        return section;
      }).join("\n\n"),
      source: "freq-test",
    });
    await refreshIndex(indexName);

    // ES uses sourceLabel (string) instead of sourceId (number)
    const terms = await store.getDistinctiveTerms(indexed.label);

    // "elasticsearch" (3/10 sections) should be in the band
    assert.ok(
      terms.includes("elasticsearch"),
      `'elasticsearch' (3/10 = within band) should be distinctive, got: [${terms.slice(0, 10).join(", ")}...]`,
    );

    // "singleton" (1/10 sections) should be filtered as too rare
    assert.ok(
      !terms.includes("singleton"),
      "'singleton' (1/10 = below min) should NOT be distinctive",
    );

    await store.close();
  });
});

describe("Edge cases and hardening", () => {
  const indexes: string[] = [];

  afterAll(async () => {
    for (const idx of indexes) {
      await cleanupIndex(idx);
    }
  });

  test("searchWithFallback on empty store returns empty", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);
    await refreshIndex(indexName);

    const results = await store.searchWithFallback("anything", 3);
    assert.equal(results.length, 0, "Empty store should return empty results");

    await store.close();
  });

  test("searchWithFallback with empty query returns empty", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    await store.indexPlainText("Some content here", "test-source");
    await refreshIndex(indexName);

    const results = await store.searchWithFallback("", 3, "test-source");
    assert.equal(results.length, 0, "Empty query should return empty results");

    await store.close();
  });

  test("searchWithFallback source scoping uses wildcard partial match", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    await store.indexPlainText(
      "Compilation succeeded with 0 warnings",
      "batch:TypeScript Build,npm test,lint",
    );
    await refreshIndex(indexName);

    // Partial source match should work (ES uses wildcard *source*)
    const results = await store.searchWithFallback("compilation", 3, "TypeScript Build");
    assert.ok(results.length > 0, "Partial source match should find content");

    await store.close();
  });

  test("searchWithFallback handles special characters in query gracefully", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    await store.indexPlainText(
      "Error in module: TypeError at line 42\nStack trace follows",
      "execute:shell",
    );
    await refreshIndex(indexName);

    // These queries with special chars should not throw
    const r1 = await store.searchWithFallback('TypeError "line 42"', 3);
    const r2 = await store.searchWithFallback("error (module)", 3);
    const r3 = await store.searchWithFallback("stack* trace", 3);
    const r4 = await store.searchWithFallback("NOT:something", 3);
    // Just verify no errors thrown — results may vary
    assert.ok(Array.isArray(r1), "Should return array");
    assert.ok(Array.isArray(r2), "Should return array");
    assert.ok(Array.isArray(r3), "Should return array");
    assert.ok(Array.isArray(r4), "Should return array");

    await store.close();
  });

  test("searchWithFallback respects limit parameter across all layers", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    // Index enough content for multiple results
    await store.index({
      content: Array.from({ length: 10 }, (_, i) =>
        `## Error ${i}\n\nTypeError: Cannot read property '${i}' of undefined at line ${i * 10}`
      ).join("\n\n"),
      source: "error-log",
    });
    await refreshIndex(indexName);

    const limited = await store.searchWithFallback("TypeError property undefined", 2);
    assert.ok(limited.length <= 2, `Limit 2 should return at most 2 results, got ${limited.length}`);

    const moreLimited = await store.searchWithFallback("TypeError property undefined", 1);
    assert.ok(moreLimited.length <= 1, `Limit 1 should return at most 1 result, got ${moreLimited.length}`);

    await store.close();
  });
});
