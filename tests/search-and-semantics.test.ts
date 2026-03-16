/**
 * Search AND semantics test — proves quality improvement from issue #23.
 *
 * Before: sanitizeQuery joined with OR → "useEffect cleanup function"
 *         matched ANY chunk with ANY of those words.
 * After:  sanitizeQuery joins with AND → only chunks with ALL words match.
 *         OR is used as fallback when AND returns nothing.
 *
 * Migrated to ContentStoreES (Elasticsearch 9.3).
 */

import { describe, test, expect, afterAll } from "vitest";
import { createTestContentStore, cleanupIndex, refreshIndex } from "./shared/es-test-helpers.js";
import { ContentStoreES } from "../src/store-es.js";

describe("AND semantics (issue #23)", () => {
  const indexes: string[] = [];

  afterAll(async () => {
    for (const idx of indexes) {
      await cleanupIndex(idx);
    }
  });

  test("multi-word query excludes irrelevant single-word matches", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    // Index two documents — one relevant, one only matches on "function"
    await store.index({
      content: "## useEffect cleanup\nReturn a cleanup function from useEffect to avoid memory leaks.\nAlways clean up subscriptions and timers in the cleanup function.",
      source: "React Hooks Guide",
    });
    await store.index({
      content: "## What is a function\nA function is a reusable block of code that performs a specific task.\nFunctions accept parameters and return values.",
      source: "JavaScript Basics",
    });
    await refreshIndex(indexName);

    // AND search: only the React chunk should match (has all 3 terms)
    const andResults = await store.search("useEffect cleanup function", 5);
    expect(andResults.length).toBe(1);
    expect(andResults[0].source).toBe("React Hooks Guide");

    // OR search: both chunks match (JS Basics matches on "function" alone)
    const orResults = await store.search("useEffect cleanup function", 5, undefined, "OR");
    expect(orResults.length).toBe(2);

    await store.close();
  });

  test("searchWithFallback uses AND by default, falls back to OR", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    await store.index({
      content: "## useEffect cleanup\nReturn a cleanup function from useEffect to avoid memory leaks.",
      source: "React Hooks Guide",
    });
    await store.index({
      content: "## What is a function\nA function is a reusable block of code.",
      source: "JavaScript Basics",
    });
    await refreshIndex(indexName);

    // searchWithFallback should use AND first — only React chunk matches
    const results = await store.searchWithFallback("useEffect cleanup function", 5);
    expect(results.length).toBe(1);
    expect(results[0].source).toBe("React Hooks Guide");

    await store.close();
  });

  test("AND with no results falls back to OR gracefully", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    await store.index({
      content: "## React components\nComponents are the building blocks of React applications.",
      source: "React Guide",
    });
    await store.index({
      content: "## Vue components\nVue uses a template-based component system.",
      source: "Vue Guide",
    });
    await refreshIndex(indexName);

    // "React useState hooks" — AND would match nothing (no chunk has all 3),
    // searchWithFallback should fall back via fuzzy/trigram and find the React chunk
    const results = await store.searchWithFallback("React useState hooks", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("React Guide");

    await store.close();
  });

  test("single-word queries work the same in AND and OR", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    await store.index({
      content: "## Authentication\nJWT tokens provide stateless authentication.",
      source: "Auth Guide",
    });
    await refreshIndex(indexName);

    const andResults = await store.search("authentication", 5);
    const orResults = await store.search("authentication", 5, undefined, "OR");
    expect(andResults.length).toBe(orResults.length);

    await store.close();
  });

  test("trigram search finds partial matches", async () => {
    const { store, indexName } = await createTestContentStore();
    indexes.push(indexName);

    await store.index({
      content: "## useEffect cleanup pattern\nReturn a cleanup function from useEffect.",
      source: "React Hooks",
    });
    await store.index({
      content: "## JavaScript function basics\nA function is a reusable block of code.",
      source: "JS Basics",
    });
    await refreshIndex(indexName);

    // Trigram search: "useEffect cleanup function" should match the React chunk
    // Note: ContentStoreES.searchTrigram does not take a mode parameter
    const andResults = await store.searchTrigram("useEffect cleanup function", 5);
    // ES ngram ranking may differ from FTS5 — verify React Hooks appears in results
    // (not necessarily first) since both chunks contain "function"
    expect(andResults.length).toBeGreaterThan(0);
    const hasReactHooks = andResults.some((r) => r.source === "React Hooks");
    expect(hasReactHooks).toBe(true);

    await store.close();
  });
});
