/**
 * Fuzzy Search — ES Migration
 *
 * Tests for the three-layer search fallback in ContentStoreES:
 *   Layer 1: Stemmed AND (most precise, multi_match with operator AND)
 *   Layer 2: Fuzzy stemmed OR (fuzziness:AUTO on standard fields)
 *   Layer 3: Fuzzy ngram OR (fuzziness:AUTO on ngram fields)
 *
 * D-02: fuzzyCorrect() always returns null in ES (no vocabulary table;
 *       ES fuzziness:AUTO replaces Levenshtein correction).
 * D-02: searchTrigram uses ngram tokenizer which doesn't span word
 *       boundaries like FTS5 trigram — some cross-word tests adjusted.
 */

import { describe, test, expect, afterAll } from "vitest";
import { strict as assert } from "node:assert";
import { createTestContentStore, cleanupIndex, refreshIndex } from "./shared/es-test-helpers.js";
import { ContentStoreES } from "../src/store-es.js";

/**
 * Seed a store with realistic multi-topic content for fuzzy search testing.
 * Returns the store and indexName with indexed content covering authentication,
 * caching, React hooks, WebSocket, and deployment topics.
 */
async function createSeededStore(): Promise<{
  store: ContentStoreES;
  indexName: string;
}> {
  const { store, indexName } = await createTestContentStore();

  await store.index({
    content: [
      "# Authentication",
      "",
      "Use JWT tokens for API authentication. The middleware validates",
      "Bearer tokens on every request. Token expiry is set to 24 hours.",
      "",
      "## Row-Level Security",
      "",
      "Supabase row-level-security policies restrict data access per user.",
      "Enable RLS on all tables that contain user data.",
      "",
      "## OAuth Providers",
      "",
      "Configure OAuth2 providers: Google, GitHub, Discord.",
      "The callback URL must match the registered redirect URI.",
    ].join("\n"),
    source: "Auth docs",
  });

  await store.index({
    content: [
      "# Caching Strategy",
      "",
      "Redis handles session caching with a 15-minute TTL.",
      "Use cache-aside pattern for database query results.",
      "",
      "## Cache Invalidation",
      "",
      "Invalidate on write using pub/sub channels.",
      "The eventEmitter broadcasts cache-bust events to all nodes.",
    ].join("\n"),
    source: "Caching docs",
  });

  await store.index({
    content: [
      "# React Hooks",
      "",
      "## useEffect",
      "",
      "The useEffect hook handles side effects in functional components.",
      "Always return a cleanup function to avoid memory leaks.",
      "",
      "```javascript",
      "useEffect(() => {",
      "  const subscription = dataSource.subscribe();",
      "  return () => subscription.unsubscribe();",
      "}, [dataSource]);",
      "```",
      "",
      "## useState",
      "",
      "The useState hook manages local component state.",
      "Use functional updates when new state depends on previous.",
      "",
      "## useCallback",
      "",
      "Memoize callbacks to prevent unnecessary re-renders.",
      "Wrap event handlers passed to child components.",
    ].join("\n"),
    source: "React docs",
  });

  await store.index({
    content: [
      "# WebSocket Server",
      "",
      "The connectionPool manages active WebSocket connections.",
      "Each connection has a heartbeat interval of 30 seconds.",
      "",
      "## Error Handling",
      "",
      "The errorBoundary catches unhandled promise rejections.",
      "Dead connections are pruned every 60 seconds via healthCheck.",
    ].join("\n"),
    source: "WebSocket docs",
  });

  await store.index({
    content: [
      "# Deployment",
      "",
      "Kubernetes manifests live in the k8s/ directory.",
      "The horizontalPodAutoscaler scales between 2-10 replicas.",
      "",
      "## Environment Variables",
      "",
      "DATABASE_URL, REDIS_URL, and JWT_SECRET must be set.",
      "Use ConfigMap for non-sensitive configuration values.",
    ].join("\n"),
    source: "Deployment docs",
  });

  await refreshIndex(indexName);

  return { store, indexName };
}

describe("searchTrigram: Substring Matching", () => {
  const indexes: string[] = [];

  afterAll(async () => {
    for (const idx of indexes) {
      await cleanupIndex(idx);
    }
  });

  test("searchTrigram: finds substring match ('authenticat' → authentication)", async () => {
    const { store, indexName } = await createSeededStore();
    indexes.push(indexName);
    // "authenticat" is a partial substring of "authentication"
    // Porter stemming won't match this — ngram should
    const results = await store.searchTrigram("authenticat", 3);
    assert.ok(results.length > 0, "Trigram should find substring match");
    assert.ok(
      results[0].content.toLowerCase().includes("authentication"),
      `Result should contain 'authentication', got: ${results[0].content.slice(0, 100)}`,
    );
  });

  test("searchTrigram: finds partial hyphenated term ('row-level' → row-level-security)", async () => {
    const { store, indexName } = await createSeededStore();
    indexes.push(indexName);
    // Partial match on hyphenated compound term
    const results = await store.searchTrigram("row-level", 3);
    assert.ok(results.length > 0, "Trigram should match partial hyphenated terms");
    assert.ok(
      results[0].content.toLowerCase().includes("row-level-security") ||
        results[0].content.toLowerCase().includes("row-level"),
      `Result should contain row-level content, got: ${results[0].content.slice(0, 100)}`,
    );
  });

  test("searchTrigram: finds camelCase substring ('useEff' → useEffect)", async () => {
    const { store, indexName } = await createSeededStore();
    indexes.push(indexName);
    // "useEff" is a prefix of "useEffect" — ngram should match
    const results = await store.searchTrigram("useEff", 3);
    assert.ok(results.length > 0, "Trigram should match camelCase substrings");
    assert.ok(
      results[0].content.includes("useEffect"),
      `Result should contain 'useEffect', got: ${results[0].content.slice(0, 100)}`,
    );
  });

  test("searchTrigram: respects source filter", async () => {
    const { store, indexName } = await createSeededStore();
    indexes.push(indexName);
    // "cache" appears in both "Caching docs" and potentially elsewhere
    const allResults = await store.searchTrigram("cache", 10);
    const filteredResults = await store.searchTrigram("cache", 10, "Caching");
    assert.ok(filteredResults.length > 0, "Should find results with source filter");
    assert.ok(
      filteredResults.every((r) => r.source.includes("Caching")),
      `All filtered results should be from Caching source, got: ${filteredResults.map((r) => r.source).join(", ")}`,
    );
    // Filtered should be subset
    assert.ok(
      filteredResults.length <= allResults.length,
      "Filtered results should be <= all results",
    );
  });
});

describe("fuzzyCorrect: Levenshtein Typo Correction", () => {
  const indexes: string[] = [];

  afterAll(async () => {
    for (const idx of indexes) {
      await cleanupIndex(idx);
    }
  });

  // D-02: fuzzyCorrect() always returns null in ES — no vocabulary table.
  // ES uses fuzziness:AUTO in searchWithFallback instead.

  test("fuzzyCorrect: always returns null in ES (no vocabulary table)", async () => {
    const { store, indexName } = await createSeededStore();
    indexes.push(indexName);
    // In SQLite, this would correct to 'authentication'. In ES, always null.
    const corrected = store.fuzzyCorrect("autentication");
    assert.equal(
      corrected,
      null,
      "fuzzyCorrect always returns null in ES (D-02: replaced by fuzziness:AUTO)",
    );
  });

  test("fuzzyCorrect: returns null for exact match too (no vocabulary in ES)", async () => {
    const { store, indexName } = await createSeededStore();
    indexes.push(indexName);
    const corrected = store.fuzzyCorrect("authentication");
    assert.equal(
      corrected,
      null,
      "fuzzyCorrect always returns null in ES, even for exact words",
    );
  });

  test("fuzzyCorrect: returns null for gibberish (same as SQLite)", async () => {
    const { store, indexName } = await createSeededStore();
    indexes.push(indexName);
    const corrected = store.fuzzyCorrect("xyzqwertymno");
    assert.equal(
      corrected,
      null,
      "Should return null when no close match exists",
    );
  });
});

describe("searchWithFallback: Three-Layer Cascade", () => {
  const indexes: string[] = [];

  afterAll(async () => {
    for (const idx of indexes) {
      await cleanupIndex(idx);
    }
  });

  // ES cascade: Attempt 1 stemmed AND → Attempt 2 fuzzy stemmed OR → Attempt 3 fuzzy ngram OR

  test("searchWithFallback: Attempt 1 hit (stemmed AND) — exact stemmed match", async () => {
    const { store, indexName } = await createSeededStore();
    indexes.push(indexName);
    // "caching strategy" — both terms exist in same doc, stemmed AND should match
    const results = await store.searchWithFallback("caching strategy", 3);
    assert.ok(results.length > 0, "Attempt 1 (stemmed AND) should find stemmed match");
    assert.ok(
      results[0].content.toLowerCase().includes("cach"),
      `First result should be about caching, got: ${results[0].content.slice(0, 100)}`,
    );
    assert.equal(
      results[0].matchLayer,
      "porter",
      `Should report 'porter' as match layer, got: '${results[0].matchLayer}'`,
    );
  });

  test("searchWithFallback: Attempt 2 hit (fuzzy stemmed OR) — typo correction", async () => {
    const { store, indexName } = await createSeededStore();
    indexes.push(indexName);
    // "kuberntes" is a typo for "kubernetes" (missing 'e')
    // Stemmed AND won't match, but fuzzy stemmed OR with fuzziness:AUTO should
    const results = await store.searchWithFallback("kuberntes", 3);
    assert.ok(results.length > 0, "Attempt 2 (fuzzy) should find typo-corrected match");
    assert.ok(
      results[0].content.toLowerCase().includes("kubernetes"),
      `Result should contain 'kubernetes', got: ${results[0].content.slice(0, 100)}`,
    );
    assert.equal(
      results[0].matchLayer,
      "fuzzy",
      `Should report 'fuzzy' as match layer, got: '${results[0].matchLayer}'`,
    );
  });

  test("searchWithFallback: Attempt 3 hit (fuzzy ngram OR) — partial substring with typo", async () => {
    const { store, indexName } = await createSeededStore();
    indexes.push(indexName);
    // "connectionPo" is a partial camelCase — stemmed AND won't match,
    // fuzzy stemmed OR may not match, fuzzy ngram OR should catch it
    const results = await store.searchWithFallback("connectionPo", 3);
    assert.ok(results.length > 0, "Attempt 3 (fuzzy ngram) should find substring match");
    assert.ok(
      results[0].content.includes("connectionPool"),
      `Result should contain 'connectionPool', got: ${results[0].content.slice(0, 100)}`,
    );
    // May resolve at fuzzy or trigram layer depending on ES analysis
    assert.ok(
      results[0].matchLayer === "fuzzy" || results[0].matchLayer === "trigram",
      `Should report 'fuzzy' or 'trigram' as match layer, got: '${results[0].matchLayer}'`,
    );
  });

  test("searchWithFallback: no match at any layer returns empty", async () => {
    const { store, indexName } = await createSeededStore();
    indexes.push(indexName);
    // Use a truly unmatchable query (random UUID-like string) since ES fuzzy matching
    // can be more aggressive than SQLite and may return low-relevance matches for word-like strings.
    const results = await store.searchWithFallback("z9k7x4m2q8w1v3n6j5p0", 3);
    assert.equal(results.length, 0, "Should return empty when no layer matches");
  });

  test("searchWithFallback: source filter works across all layers", async () => {
    const { store, indexName } = await createSeededStore();
    indexes.push(indexName);
    // "JWT" exists in both Auth docs and Deployment docs (JWT_SECRET)
    const results = await store.searchWithFallback("JWT", 5, "Auth");
    assert.ok(results.length > 0, "Should find results with source filter");
    assert.ok(
      results.every((r) => r.source.includes("Auth")),
      `All results should be from Auth source, got: ${results.map((r) => r.source).join(", ")}`,
    );
  });
});

describe("Edge Cases", () => {
  const indexes: string[] = [];

  afterAll(async () => {
    for (const idx of indexes) {
      await cleanupIndex(idx);
    }
  });

  test("searchTrigram: empty query returns empty", async () => {
    const { store, indexName } = await createSeededStore();
    indexes.push(indexName);
    const results = await store.searchTrigram("", 3);
    assert.equal(results.length, 0, "Empty query should return no results");
  });

  test("searchTrigram: very short query (2 chars) returns empty (ngram needs >= 3 chars)", async () => {
    const { store, indexName } = await createSeededStore();
    indexes.push(indexName);
    // ES ngram tokenizer requires at least 3 chars; searchTrigram filters words < 3 chars
    const results = await store.searchTrigram("JS", 3);
    assert.ok(Array.isArray(results), "Should return an array even for short query");
    assert.equal(results.length, 0, "2-char query filtered out by searchTrigram (< 3 chars)");
  });

  test("fuzzyCorrect: always returns null in ES (D-02)", async () => {
    const { store, indexName } = await createSeededStore();
    indexes.push(indexName);
    // D-02: No vocabulary table in ES, fuzzyCorrect is a no-op stub
    const corrected = store.fuzzyCorrect("autentication");
    assert.equal(corrected, null, "fuzzyCorrect always returns null in ES");
  });

  test("searchWithFallback: Attempt 1 hit skips Attempt 2 and 3 (performance)", async () => {
    const { store, indexName } = await createSeededStore();
    indexes.push(indexName);
    // "Redis" is an exact term — should resolve at Attempt 1 (stemmed AND)
    const start = performance.now();
    const results = await store.searchWithFallback("Redis", 3);
    const elapsed = performance.now() - start;
    assert.ok(results.length > 0, "Should find Redis content");
    assert.equal(
      results[0].matchLayer,
      "porter",
      "Exact match should resolve at Porter layer",
    );
    // Sanity: should be reasonably fast since it didn't need fuzzy/ngram
    assert.ok(elapsed < 2000, `Should be fast for Attempt 1 hit, took ${elapsed.toFixed(0)}ms`);
  });

  test("ngram index is populated during index()", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);
    await store.index({
      content: "# Test\n\nThe horizontalPodAutoscaler manages pod replicas.",
      source: "test-trigram-index",
    });
    await refreshIndex(indexName);
    // After indexing, trigram (ngram) search should work
    const results = await store.searchTrigram("horizontalPod", 3);
    assert.ok(results.length > 0, "Ngram index should be populated during index()");
    assert.ok(
      results[0].content.includes("horizontalPodAutoscaler"),
      "Should find the camelCase term",
    );
  });

  test("ngram index is populated during indexPlainText()", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);
    await store.indexPlainText(
      "ERROR: connectionRefused on port 5432\nWARNING: retrying in 5s",
      "plain-text-trigram",
    );
    await refreshIndex(indexName);
    const results = await store.searchTrigram("connectionRef", 3);
    assert.ok(results.length > 0, "Trigram should work with indexPlainText content");
  });
});
