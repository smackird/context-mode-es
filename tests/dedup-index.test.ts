import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { ContentStoreES } from "../src/store-es.js";
import {
  createTestContentStore,
  cleanupIndex,
  refreshIndex,
} from "./shared/es-test-helpers.js";

describe("Index deduplication (issue #67)", () => {
  let store: ContentStoreES;
  let indexName: string;

  beforeEach(async () => {
    const created = await createTestContentStore();
    store = created.store;
    indexName = created.indexName;
  });

  afterAll(async () => {
    if (indexName) {
      await cleanupIndex(indexName);
    }
  });

  it("re-indexing with same label replaces previous content", async () => {
    // First build: error A
    await store.index({
      content: "# Build Output\nERROR: Module not found 'foo'",
      source: "execute:shell:npm run build",
    });
    await refreshIndex(indexName);

    // Verify error A is searchable
    const results1 = await store.search("Module not found foo");
    expect(results1.length).toBeGreaterThan(0);
    expect(results1[0].content).toContain("Module not found");

    // Second build: error A fixed, new error B
    await store.index({
      content: "# Build Output\nERROR: Type 'string' is not assignable to type 'number'",
      source: "execute:shell:npm run build",
    });
    await refreshIndex(indexName);

    // Error B should be searchable
    const results2 = await store.search("Type string not assignable number");
    expect(results2.length).toBeGreaterThan(0);
    expect(results2[0].content).toContain("not assignable");

    // Error A should NO LONGER be searchable
    const results3 = await store.search("Module not found foo");
    expect(results3.length).toBe(0);
  });

  it("different labels are NOT deduped", async () => {
    await store.index({
      content: "# Test Output\n5 tests passed",
      source: "execute:shell:npm test",
    });
    await store.index({
      content: "# Build Output\nBuild successful",
      source: "execute:shell:npm run build",
    });
    await refreshIndex(indexName);

    // Both should be searchable
    const testResults = await store.search("tests passed");
    expect(testResults.length).toBeGreaterThan(0);

    const buildResults = await store.search("Build successful");
    expect(buildResults.length).toBeGreaterThan(0);
  });

  it("sources list shows only one entry per label after dedup", async () => {
    await store.index({ content: "# Run 1\nfail", source: "execute:shell:make" });
    await store.index({ content: "# Run 2\nfail", source: "execute:shell:make" });
    await store.index({ content: "# Run 3\npass", source: "execute:shell:make" });
    await refreshIndex(indexName);

    const sources = await store.listSources();
    const makeEntries = sources.filter((s) => s.label === "execute:shell:make");
    expect(makeEntries.length).toBe(1);
    expect(makeEntries[0].chunkCount).toBeGreaterThan(0);
  });

  it("dedup works with indexPlainText too", async () => {
    await store.indexPlainText("error: old failure", "build-output");
    await store.indexPlainText("success: all good", "build-output");
    await refreshIndex(indexName);

    const oldResults = await store.search("old failure");
    expect(oldResults.length).toBe(0);

    const newResults = await store.search("all good");
    expect(newResults.length).toBeGreaterThan(0);
  });

  it("dedup works with indexJSON too", async () => {
    await store.indexJSON(
      JSON.stringify({ status: "error", message: "connection refused" }),
      "api-response",
    );
    await store.indexJSON(
      JSON.stringify({ status: "ok", data: [1, 2, 3] }),
      "api-response",
    );
    await refreshIndex(indexName);

    const oldResults = await store.search("connection refused");
    expect(oldResults.length).toBe(0);

    const newResults = await store.searchWithFallback("ok", 5);
    expect(newResults.length).toBeGreaterThan(0);
  });

  it("trigram search also returns only latest content after dedup", async () => {
    await store.index({
      content: "# Output\nxyz123oldvalue",
      source: "execute:shell:check",
    });
    await store.index({
      content: "# Output\nabc456newvalue",
      source: "execute:shell:check",
    });
    await refreshIndex(indexName);

    // Trigram search for old unique substring
    // ES ngram tokenizer may produce partial matches from new content; verify old content chunk is gone
    const oldResults = await store.searchWithFallback("xyz123oldvalue", 5);
    for (const r of oldResults) {
      expect(r.content).not.toContain("xyz123oldvalue");
    }

    // Trigram search for new unique substring
    const newResults = await store.searchWithFallback("abc456newvalue", 5);
    expect(newResults.length).toBeGreaterThan(0);
  });
});
