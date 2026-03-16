/**
 * Search Fallback Integration Tests
 *
 * Regression tests for fixes #2 and #3: verifying that `searchWithFallback`
 * works correctly with source-scoped persistent stores — the exact code path
 * used by `intentSearch` and `batch_execute` after eliminating the ephemeral
 * ContentStore(":memory:") pattern.
 *
 * These tests exercise the production search path:
 *   1. Index content into a persistent store via `indexPlainText`
 *   2. Search with `searchWithFallback(query, limit, source)` (source-scoped)
 *   3. Verify fallback cascade: porter → fuzzy → trigram (3 attempts in ES)
 *
 * Migrated to ContentStoreES (Elasticsearch 9.3).
 */

import { describe, test, afterAll } from "vitest";
import { strict as assert } from "node:assert";
import { createTestContentStore, cleanupIndex, refreshIndex } from "./shared/es-test-helpers.js";
import { ContentStoreES } from "../src/store-es.js";

// ─────────────────────────────────────────────────────────
// Mirrors the production intentSearch code path:
//   persistent.indexPlainText(stdout, source)
//   persistent.searchWithFallback(intent, maxResults, source)
// ─────────────────────────────────────────────────────────

describe("Source-scoped searchWithFallback (intentSearch path)", () => {
  const indexes: string[] = [];

  afterAll(async () => {
    for (const idx of indexes) {
      await cleanupIndex(idx);
    }
  });

  test("intentSearch path: porter layer finds exact terms in source-scoped search", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    // Index two different sources (simulates multiple execute calls)
    await store.indexPlainText(
      "ERROR: connection refused to database at 10.0.0.5:5432\nRetry 3/3 failed",
      "cmd-1: psql status",
    );
    await store.indexPlainText(
      "All 42 tests passed in 3.2s\nCoverage: 87%",
      "cmd-2: npm test",
    );
    await refreshIndex(indexName);

    // Source-scoped search should only find results from the target source
    const results = await store.searchWithFallback("connection refused", 3, "cmd-1");
    assert.ok(results.length > 0, "Should find results in cmd-1");
    assert.ok(
      results[0].content.includes("connection refused"),
      "Result should contain the search term",
    );
    assert.equal(results[0].matchLayer, "porter", "Should match via porter layer");

    // Should NOT leak results from other sources.
    // Use a source filter that cannot wildcard-match cmd-1 content.
    const wrongSource = await store.searchWithFallback("database connection", 3, "cmd-2: npm test");
    assert.equal(wrongSource.length, 0, "Should not find database errors in test output source");

    await store.close();
  });

  test("intentSearch path: fuzzy/trigram layer activates for partial/camelCase terms", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    await store.indexPlainText(
      "The horizontalPodAutoscaler scaled deployment to 5 replicas\nCPU usage at 78%",
      "cmd-1: kubectl status",
    );
    await refreshIndex(indexName);

    // "horizontalPod" is a partial camelCase term — porter won't match,
    // ES cascade: porter -> fuzzy -> trigram
    const results = await store.searchWithFallback("horizontalPod", 3, "cmd-1");
    assert.ok(results.length > 0, "Fuzzy or trigram should find partial camelCase match");
    assert.ok(
      results[0].content.includes("horizontalPodAutoscaler"),
      "Should find the full term",
    );
    // In ES, the cascade is porter -> fuzzy -> trigram (3 attempts)
    assert.ok(
      results[0].matchLayer === "fuzzy" || results[0].matchLayer === "trigram",
      `Should match via fuzzy or trigram layer, got '${results[0].matchLayer}'`,
    );

    await store.close();
  });

  test("intentSearch path: fuzzy layer activates for typos", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    await store.indexPlainText(
      "Kubernetes deployment rolled out successfully\nAll pods healthy",
      "cmd-1: kubectl rollout",
    );
    await refreshIndex(indexName);

    // "kuberntes" is a typo for "kubernetes" — fuzzy layer should correct
    const results = await store.searchWithFallback("kuberntes", 3, "cmd-1");
    assert.ok(results.length > 0, "Fuzzy should correct typo and find match");
    assert.ok(
      results[0].content.toLowerCase().includes("kubernetes"),
      "Should find kubernetes content",
    );
    // In ES cascade: porter -> fuzzy -> trigram; typo correction is via fuzzy
    assert.ok(
      results[0].matchLayer === "fuzzy" || results[0].matchLayer === "trigram",
      `Should match via fuzzy or trigram layer, got '${results[0].matchLayer}'`,
    );

    await store.close();
  });

  test("intentSearch path: no match returns empty (not an error)", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    await store.indexPlainText(
      "Server started on port 3000\nReady to accept connections",
      "cmd-1: node server",
    );
    await refreshIndex(indexName);

    // Use a truly unmatchable query (random UUID-like string) since ES fuzzy matching
    // can be more aggressive than SQLite for word-like gibberish strings.
    const results = await store.searchWithFallback("z9k7x4m2q8w1v3n6j5p0", 3, "cmd-1");
    assert.equal(results.length, 0, "Completely unrelated query should return empty");

    await store.close();
  });
});

describe("Multi-source isolation (batch_execute path)", () => {
  const indexes: string[] = [];

  afterAll(async () => {
    for (const idx of indexes) {
      await cleanupIndex(idx);
    }
  });

  test("batch_execute path: scoped search isolates results per source", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    // Simulate batch_execute indexing multiple command outputs
    await store.index({
      content: "# Git Status\n\nOn branch main\n3 files changed, 42 insertions",
      source: "batch: git status",
    });
    await store.index({
      content: "# Test Results\n\nAll 100 tests passed\n0 failures, 0 skipped",
      source: "batch: npm test",
    });
    await store.index({
      content: "# Build Output\n\nCompiled 47 files in 2.3s\nBundle size: 142KB",
      source: "batch: npm build",
    });
    await refreshIndex(indexName);

    // Each scoped search should only return results from its source
    const gitResults = await store.searchWithFallback("files changed", 3, "batch: git status");
    assert.ok(gitResults.length > 0, "Should find git status results");
    assert.ok(gitResults.every(r => r.source.includes("git status")), "All results should be from git status");

    const testResults = await store.searchWithFallback("tests passed", 3, "batch: npm test");
    assert.ok(testResults.length > 0, "Should find test results");
    assert.ok(testResults.every(r => r.source.includes("npm test")), "All results should be from npm test");

    // Global fallback (no source filter) should search across all sources
    const globalResults = await store.searchWithFallback("files", 10);
    assert.ok(globalResults.length > 0, "Global search should find results");

    await store.close();
  });

  test("batch_execute path: global fallback when scoped search fails", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    // Index content into one source
    await store.index({
      content: "# Authentication\n\nJWT tokens expire after 24 hours\nRefresh tokens last 7 days",
      source: "docs: auth",
    });
    await refreshIndex(indexName);

    // Scoped search against wrong source returns empty
    const wrongScope = await store.searchWithFallback("JWT tokens", 3, "docs: nonexistent");
    assert.equal(wrongScope.length, 0, "Wrong source scope should return empty");

    // Global fallback (no source) should find it
    const globalFallback = await store.searchWithFallback("JWT tokens", 3);
    assert.ok(globalFallback.length > 0, "Global fallback should find the content");

    await store.close();
  });
});

describe("getDistinctiveTerms consistency (fix #9)", () => {
  const indexes: string[] = [];

  afterAll(async () => {
    for (const idx of indexes) {
      await cleanupIndex(idx);
    }
  });

  test("getDistinctiveTerms returns terms for multi-chunk content", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    // getDistinctiveTerms requires chunk_count >= 3 and terms appearing in
    // at least 2 chunks. Use markdown with multiple headings to force chunking.
    const indexed = await store.index({
      content: [
        "# Kubernetes Overview",
        "",
        "The horizontalPodAutoscaler manages Kubernetes pod replicas.",
        "Kubernetes clusters run containerized workloads.",
        "",
        "# Kubernetes Networking",
        "",
        "Kubernetes services expose pods via ClusterIP or LoadBalancer.",
        "The horizontalPodAutoscaler scales based on CPU metrics.",
        "",
        "# Kubernetes Storage",
        "",
        "PersistentVolumeClaims request storage from Kubernetes.",
        "The horizontalPodAutoscaler can also use custom metrics.",
        "",
        "# Monitoring",
        "",
        "Prometheus scrapes metrics from Kubernetes pods.",
        "Alerts fire when horizontalPodAutoscaler hits max replicas.",
      ].join("\n"),
      source: "k8s-docs",
    });
    await refreshIndex(indexName);

    // ES uses sourceLabel (string) instead of sourceId (number)
    const terms = await store.getDistinctiveTerms(indexed.label);
    assert.ok(Array.isArray(terms), "Should return an array");
    assert.ok(terms.length > 0, `Should extract distinctive terms, got ${terms.length}`);

    // Terms appearing in ALL chunks are filtered as too common; terms in
    // only 1 chunk are filtered as too rare. The middle band survives.
    for (const term of terms) {
      assert.ok(term.length >= 3, `Term "${term}" should be at least 3 chars`);
    }

    await store.close();
  });
});
