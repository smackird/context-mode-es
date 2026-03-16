/**
 * ContentStoreES — ES-backed knowledge base for context-mode-es.
 *
 * Async replacement for the synchronous SQLite/FTS5-backed ContentStore.
 * Chunks markdown/plaintext/JSON content, indexes into ES with stemmed +
 * ngram multi-field analyzers, and retrieves via BM25-ranked search with
 * fallback cascade.
 *
 * Reference: plans/merged/file_and_function_mapping/merged_src_store_v1.md
 */

import type { Client } from "@elastic/elasticsearch";
import { readFileSync } from "node:fs";
import type { IndexResult, SearchResult, StoreStats } from "./types.js";
export type { IndexResult, SearchResult, StoreStats } from "./types.js";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

interface Chunk {
  title: string;
  content: string;
  hasCode: boolean;
}

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "his", "how", "its", "may",
  "new", "now", "old", "see", "way", "who", "did", "get", "got", "let",
  "say", "she", "too", "use", "will", "with", "this", "that", "from",
  "they", "been", "have", "many", "some", "them", "than", "each", "make",
  "like", "just", "over", "such", "take", "into", "year", "your", "good",
  "could", "would", "about", "which", "their", "there", "other", "after",
  "should", "through", "also", "more", "most", "only", "very", "when",
  "what", "then", "these", "those", "being", "does", "done", "both",
  "same", "still", "while", "where", "here", "were", "much",
  "update", "updates", "updated", "deps", "dev", "tests", "test",
  "add", "added", "fix", "fixed", "run", "running", "using",
]);

const MAX_CHUNK_BYTES = 4000;

// ─────────────────────────────────────────────────────────
// Index settings & mappings
// ─────────────────────────────────────────────────────────

const CONTENT_SETTINGS = {
  number_of_shards: 1,
  number_of_replicas: 0,
  analysis: {
    analyzer: {
      content_stemmed: {
        type: "custom" as const,
        tokenizer: "standard",
        filter: ["lowercase", "english_stemmer"],
      },
      content_ngram: {
        type: "custom" as const,
        tokenizer: "standard",
        filter: ["lowercase", "content_ngram_filter"],
      },
    },
    filter: {
      english_stemmer: { type: "stemmer" as const, language: "english" },
      content_ngram_filter: {
        type: "ngram" as const,
        min_gram: 3,
        max_gram: 3,
      },
    },
  },
};

const CONTENT_MAPPINGS = {
  properties: {
    title: {
      type: "text" as const,
      analyzer: "content_stemmed",
      fields: {
        ngram: { type: "text" as const, analyzer: "content_ngram" },
      },
    },
    content: {
      type: "text" as const,
      analyzer: "content_stemmed",
      fields: {
        ngram: { type: "text" as const, analyzer: "content_ngram" },
      },
    },
    source_label: {
      type: "text" as const,
      analyzer: "standard",
      fields: {
        keyword: { type: "keyword" as const },
      },
    },
    content_type: { type: "keyword" as const },
    chunk_position: { type: "integer" as const },
    indexed_at: { type: "date" as const },
    has_code: { type: "boolean" as const },
  },
};

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function labelToIdPrefix(label: string): string {
  return Buffer.from(label).toString("base64url");
}

function chunkDocId(label: string, position: number): string {
  return `${labelToIdPrefix(label)}:chunk:${String(position).padStart(6, "0")}`;
}

// ─────────────────────────────────────────────────────────
// Cleanup stub (replaces cleanupStaleDBs)
// ─────────────────────────────────────────────────────────

/** No-op stub — ES indices are not PID-scoped temp files. */
export function cleanupStaleIndices(): number {
  return 0;
}

// ─────────────────────────────────────────────────────────
// ContentStoreES
// ─────────────────────────────────────────────────────────

export class ContentStoreES {
  private constructor(
    private client: Client,
    private indexName: string,
  ) {}

  static async create(
    client: Client,
    indexName: string,
  ): Promise<ContentStoreES> {
    const exists = await client.indices.exists({ index: indexName });
    if (!exists) {
      await client.indices.create({
        index: indexName,
        settings: CONTENT_SETTINGS,
        mappings: CONTENT_MAPPINGS,
      });
    }
    return new ContentStoreES(client, indexName);
  }

  // ═══════════════════════════════════════════
  // Index
  // ═══════════════════════════════════════════

  async index(options: {
    content?: string;
    path?: string;
    source?: string;
  }): Promise<IndexResult> {
    const { content, path, source } = options;
    if (!content && !path) {
      throw new Error("Either content or path must be provided");
    }
    const text = content ?? readFileSync(path!, "utf-8");
    const label = source ?? path ?? "untitled";
    const chunks = this.chunkMarkdown(text);
    return this.insertChunks(chunks, label);
  }

  async indexPlainText(
    content: string,
    source: string,
    linesPerChunk: number = 20,
  ): Promise<IndexResult> {
    if (!content || content.trim().length === 0) {
      return this.insertChunks([], source);
    }
    const chunks = this.chunkPlainText(content, linesPerChunk);
    return this.insertChunks(
      chunks.map((c) => ({ ...c, hasCode: false })),
      source,
    );
  }

  async indexJSON(
    content: string,
    source: string,
    maxChunkBytes: number = MAX_CHUNK_BYTES,
  ): Promise<IndexResult> {
    if (!content || content.trim().length === 0) {
      return this.indexPlainText("", source);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return this.indexPlainText(content, source);
    }
    const chunks: Chunk[] = [];
    this.walkJSON(parsed, [], chunks, maxChunkBytes);
    if (chunks.length === 0) {
      return this.indexPlainText(content, source);
    }
    return this.insertChunks(chunks, source);
  }

  // ── Shared insertion logic ──

  private async insertChunks(
    chunks: Chunk[],
    label: string,
  ): Promise<IndexResult> {
    const codeChunks = chunks.filter((c) => c.hasCode).length;

    // Delete previous chunks for this source label
    await this.client.deleteByQuery({
      index: this.indexName,
      query: { term: { "source_label.keyword": label } },
      refresh: true,
    });

    // No chunks = empty source, don't index anything (per D-04)
    if (chunks.length === 0) {
      return { sourceId: 0, label, totalChunks: 0, codeChunks: 0 };
    }

    // Bulk index all chunks
    const now = new Date().toISOString();
    const operations = chunks.flatMap((chunk, i) => [
      { index: { _index: this.indexName, _id: chunkDocId(label, i) } },
      {
        title: chunk.title,
        content: chunk.content,
        source_label: label,
        content_type: chunk.hasCode ? "code" : "prose",
        chunk_position: i,
        indexed_at: now,
        has_code: chunk.hasCode,
      },
    ]);

    await this.client.bulk({ operations, refresh: true });

    return { sourceId: 0, label, totalChunks: chunks.length, codeChunks };
  }

  // ═══════════════════════════════════════════
  // Search
  // ═══════════════════════════════════════════

  async search(
    query: string,
    limit: number = 3,
    source?: string,
    mode: "AND" | "OR" = "AND",
  ): Promise<SearchResult[]> {
    const must: Record<string, unknown> = {
      multi_match: {
        query,
        fields: ["title^2", "content"],
        operator: mode.toLowerCase(),
      },
    };

    const filter: Array<Record<string, unknown>> = [];
    if (source) {
      filter.push({
        wildcard: {
          "source_label.keyword": {
            value: `*${source}*`,
            case_insensitive: true,
          },
        },
      });
    }

    const result = await this.client.search({
      index: this.indexName,
      size: limit,
      query: {
        bool: {
          must: [must],
          ...(filter.length > 0 ? { filter } : {}),
        },
      },
      highlight: {
        fields: { content: {} },
        pre_tags: ["\x02"],
        post_tags: ["\x03"],
      },
    });

    return result.hits.hits.map((hit) => {
      const src = hit._source as Record<string, unknown>;
      const hl = hit.highlight?.content?.[0] ?? "";
      return {
        title: src.title as string,
        content: src.content as string,
        source: src.source_label as string,
        rank: -(hit._score ?? 0),
        contentType: (src.content_type as "code" | "prose"),
        highlighted: hl,
      };
    });
  }

  async searchTrigram(
    query: string,
    limit: number = 3,
    source?: string,
  ): Promise<SearchResult[]> {
    // Require at least 3 chars for trigram search
    const words = query.trim().split(/\s+/).filter((w) => w.length >= 3);
    if (words.length === 0) return [];

    const filter: Array<Record<string, unknown>> = [];
    if (source) {
      filter.push({
        wildcard: {
          "source_label.keyword": {
            value: `*${source}*`,
            case_insensitive: true,
          },
        },
      });
    }

    const result = await this.client.search({
      index: this.indexName,
      size: limit,
      query: {
        bool: {
          must: [{
            multi_match: {
              query: words.join(" "),
              fields: ["title.ngram", "content.ngram"],
              operator: "or",
            },
          }],
          ...(filter.length > 0 ? { filter } : {}),
        },
      },
      highlight: {
        fields: { content: {} },
        pre_tags: ["\x02"],
        post_tags: ["\x03"],
      },
    });

    return result.hits.hits.map((hit) => {
      const src = hit._source as Record<string, unknown>;
      const hl = hit.highlight?.content?.[0] ?? "";
      return {
        title: src.title as string,
        content: src.content as string,
        source: src.source_label as string,
        rank: -(hit._score ?? 0),
        contentType: (src.content_type as "code" | "prose"),
        highlighted: hl,
      };
    });
  }

  /** No-op stub — ES `fuzziness: "AUTO"` replaces vocabulary-based correction. */
  fuzzyCorrect(_query: string): null {
    return null;
  }

  async searchWithFallback(
    query: string,
    limit: number = 3,
    source?: string,
  ): Promise<SearchResult[]> {
    // Attempt 1: Stemmed AND (most precise)
    const stemmedAnd = await this.search(query, limit, source, "AND");
    if (stemmedAnd.length > 0) {
      return stemmedAnd.map((r) => ({ ...r, matchLayer: "porter" as const }));
    }

    // Attempt 2: Fuzzy stemmed OR
    const fuzzyOr = await this.searchFuzzy(query, limit, source, ["title^2", "content"]);
    if (fuzzyOr.length > 0) {
      return fuzzyOr.map((r) => ({ ...r, matchLayer: "fuzzy" as const }));
    }

    // Attempt 3: Fuzzy ngram OR
    const fuzzyNgram = await this.searchFuzzy(query, limit, source, ["title.ngram", "content.ngram"]);
    if (fuzzyNgram.length > 0) {
      return fuzzyNgram.map((r) => ({ ...r, matchLayer: "trigram" as const }));
    }

    return [];
  }

  /** Internal fuzzy search helper for searchWithFallback. */
  private async searchFuzzy(
    query: string,
    limit: number,
    source: string | undefined,
    fields: string[],
  ): Promise<SearchResult[]> {
    const filter: Array<Record<string, unknown>> = [];
    if (source) {
      filter.push({
        wildcard: {
          "source_label.keyword": {
            value: `*${source}*`,
            case_insensitive: true,
          },
        },
      });
    }

    const result = await this.client.search({
      index: this.indexName,
      size: limit,
      query: {
        bool: {
          must: [{
            multi_match: {
              query,
              fields,
              operator: "or",
              fuzziness: "AUTO",
            },
          }],
          ...(filter.length > 0 ? { filter } : {}),
        },
      },
      highlight: {
        fields: { content: {} },
        pre_tags: ["\x02"],
        post_tags: ["\x03"],
      },
    });

    return result.hits.hits.map((hit) => {
      const src = hit._source as Record<string, unknown>;
      const hl = hit.highlight?.content?.[0] ?? "";
      return {
        title: src.title as string,
        content: src.content as string,
        source: src.source_label as string,
        rank: -(hit._score ?? 0),
        contentType: (src.content_type as "code" | "prose"),
        highlighted: hl,
      };
    });
  }

  // ═══════════════════════════════════════════
  // Sources
  // ═══════════════════════════════════════════

  async listSources(): Promise<Array<{ label: string; chunkCount: number }>> {
    const result = await this.client.search({
      index: this.indexName,
      size: 0,
      aggs: {
        sources: {
          terms: {
            field: "source_label.keyword",
            size: 10000,
            order: { latest: "desc" },
          },
          aggs: {
            latest: { max: { field: "indexed_at" } },
          },
        },
      },
    });

    const buckets = (result.aggregations?.sources as {
      buckets: Array<{ key: string; doc_count: number }>;
    })?.buckets ?? [];

    return buckets.map((b) => ({
      label: b.key,
      chunkCount: b.doc_count,
    }));
  }

  async getChunksBySource(sourceLabel: string): Promise<SearchResult[]> {
    const result = await this.client.search({
      index: this.indexName,
      size: 10000,
      query: {
        term: { "source_label.keyword": sourceLabel },
      },
      sort: [{ chunk_position: "asc" }],
    });

    return result.hits.hits.map((hit) => {
      const src = hit._source as Record<string, unknown>;
      return {
        title: src.title as string,
        content: src.content as string,
        source: src.source_label as string,
        rank: 0,
        contentType: (src.content_type as "code" | "prose"),
      };
    });
  }

  async getDistinctiveTerms(
    sourceLabel: string,
    maxTerms: number = 40,
  ): Promise<string[]> {
    // Fetch all chunks for this source
    const result = await this.client.search({
      index: this.indexName,
      size: 10000,
      query: {
        term: { "source_label.keyword": sourceLabel },
      },
      _source: ["content"],
    });

    const chunks = result.hits.hits.map(
      (hit) => (hit._source as { content: string }).content,
    );

    if (chunks.length < 3) return [];

    const totalChunks = chunks.length;
    const minAppearances = 2;
    const maxAppearances = Math.max(3, Math.ceil(totalChunks * 0.4));

    const docFreq = new Map<string, number>();

    for (const content of chunks) {
      const words = new Set(
        content
          .toLowerCase()
          .split(/[^\p{L}\p{N}_-]+/u)
          .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
      );
      for (const word of words) {
        docFreq.set(word, (docFreq.get(word) ?? 0) + 1);
      }
    }

    const filtered = Array.from(docFreq.entries()).filter(
      ([, count]) => count >= minAppearances && count <= maxAppearances,
    );

    const scored = filtered.map(([word, count]: [string, number]) => {
      const idf = Math.log(totalChunks / count);
      const lenBonus = Math.min(word.length / 20, 0.5);
      const hasSpecialChars = /[_]/.test(word);
      const isCamelOrLong = word.length >= 12;
      const identifierBonus = hasSpecialChars ? 1.5 : isCamelOrLong ? 0.8 : 0;
      return { word, score: idf + lenBonus + identifierBonus };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, maxTerms)
      .map((s) => s.word);
  }

  // ═══════════════════════════════════════════
  // Stats
  // ═══════════════════════════════════════════

  async getStats(): Promise<StoreStats> {
    const countResult = await this.client.count({ index: this.indexName });
    const chunks = countResult.count;

    const sourceResult = await this.client.search({
      index: this.indexName,
      size: 0,
      aggs: {
        source_count: {
          cardinality: { field: "source_label.keyword" },
        },
        code_count: {
          filter: { term: { content_type: "code" } },
        },
      },
    });

    const sources =
      (sourceResult.aggregations?.source_count as { value: number })?.value ?? 0;
    const codeChunks =
      (sourceResult.aggregations?.code_count as { doc_count: number })
        ?.doc_count ?? 0;

    return { sources, chunks, codeChunks };
  }

  // ═══════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════

  async close(): Promise<void> {
    // Client lifecycle managed by closeClient() in es-base.ts
  }

  async cleanup(): Promise<void> {
    try {
      await this.client.indices.delete({
        index: this.indexName,
        ignore_unavailable: true,
      });
    } catch {
      // Swallow errors in cleanup path
    }
  }

  // ═══════════════════════════════════════════
  // Chunking (carried over unchanged from store.ts)
  // ═══════════════════════════════════════════

  private chunkMarkdown(
    text: string,
    maxChunkBytes: number = MAX_CHUNK_BYTES,
  ): Chunk[] {
    const chunks: Chunk[] = [];
    const lines = text.split("\n");
    const headingStack: Array<{ level: number; text: string }> = [];
    let currentContent: string[] = [];
    let currentHeading = "";

    const flush = () => {
      const joined = currentContent.join("\n").trim();
      if (joined.length === 0) return;

      const title = this.buildTitle(headingStack, currentHeading);
      const hasCode = currentContent.some((l) => /^`{3,}/.test(l));

      if (Buffer.byteLength(joined) <= maxChunkBytes) {
        chunks.push({ title, content: joined, hasCode });
        currentContent = [];
        return;
      }

      const paragraphs = joined.split(/\n\n+/);
      let accumulator: string[] = [];
      let partIndex = 1;

      const flushAccumulator = () => {
        if (accumulator.length === 0) return;
        const part = accumulator.join("\n\n").trim();
        if (part.length === 0) return;
        const partTitle =
          paragraphs.length > 1 ? `${title} (${partIndex})` : title;
        partIndex++;
        chunks.push({
          title: partTitle,
          content: part,
          hasCode: part.includes("```"),
        });
        accumulator = [];
      };

      for (const para of paragraphs) {
        accumulator.push(para);
        const candidate = accumulator.join("\n\n");
        if (
          Buffer.byteLength(candidate) > maxChunkBytes &&
          accumulator.length > 1
        ) {
          accumulator.pop();
          flushAccumulator();
          accumulator = [para];
        }
      }
      flushAccumulator();
      currentContent = [];
    };

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (/^[-_*]{3,}\s*$/.test(line)) {
        flush();
        i++;
        continue;
      }

      const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        flush();
        const level = headingMatch[1].length;
        const heading = headingMatch[2].trim();
        while (
          headingStack.length > 0 &&
          headingStack[headingStack.length - 1].level >= level
        ) {
          headingStack.pop();
        }
        headingStack.push({ level, text: heading });
        currentHeading = heading;
        currentContent.push(line);
        i++;
        continue;
      }

      const codeMatch = line.match(/^(`{3,})(.*)?$/);
      if (codeMatch) {
        const fence = codeMatch[1];
        const codeLines: string[] = [line];
        i++;
        while (i < lines.length) {
          codeLines.push(lines[i]);
          if (lines[i].startsWith(fence) && lines[i].trim() === fence) {
            i++;
            break;
          }
          i++;
        }
        currentContent.push(...codeLines);
        continue;
      }

      currentContent.push(line);
      i++;
    }

    flush();
    return chunks;
  }

  private chunkPlainText(
    text: string,
    linesPerChunk: number,
  ): Array<{ title: string; content: string }> {
    const sections = text.split(/\n\s*\n/);
    if (
      sections.length >= 3 &&
      sections.length <= 200 &&
      sections.every((s) => Buffer.byteLength(s) < 5000)
    ) {
      return sections
        .map((section, i) => {
          const trimmed = section.trim();
          const firstLine = trimmed.split("\n")[0].slice(0, 80);
          return {
            title: firstLine || `Section ${i + 1}`,
            content: trimmed,
          };
        })
        .filter((s) => s.content.length > 0);
    }

    const lines = text.split("\n");
    if (lines.length <= linesPerChunk) {
      return [{ title: "Output", content: text }];
    }

    const chunks: Array<{ title: string; content: string }> = [];
    const overlap = 2;
    const step = Math.max(linesPerChunk - overlap, 1);

    for (let i = 0; i < lines.length; i += step) {
      const slice = lines.slice(i, i + linesPerChunk);
      if (slice.length === 0) break;
      const startLine = i + 1;
      const endLine = Math.min(i + slice.length, lines.length);
      const firstLine = slice[0]?.trim().slice(0, 80);
      chunks.push({
        title: firstLine || `Lines ${startLine}-${endLine}`,
        content: slice.join("\n"),
      });
    }

    return chunks;
  }

  private walkJSON(
    value: unknown,
    path: string[],
    chunks: Chunk[],
    maxChunkBytes: number,
  ): void {
    const title = path.length > 0 ? path.join(" > ") : "(root)";
    const serialized = JSON.stringify(value, null, 2);

    if (Buffer.byteLength(serialized) <= maxChunkBytes) {
      const shouldRecurse =
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).some(
          (v) => typeof v === "object" && v !== null,
        );

      if (!shouldRecurse) {
        chunks.push({ title, content: serialized, hasCode: true });
        return;
      }
    }

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const entries = Object.entries(value);
      if (entries.length > 0) {
        for (const [key, val] of entries) {
          this.walkJSON(val, [...path, key], chunks, maxChunkBytes);
        }
        return;
      }
      chunks.push({ title, content: serialized, hasCode: true });
      return;
    }

    if (Array.isArray(value)) {
      this.chunkJSONArray(value, path, chunks, maxChunkBytes);
      return;
    }

    chunks.push({ title, content: serialized, hasCode: false });
  }

  private findIdentityField(arr: unknown[]): string | null {
    if (arr.length === 0) return null;
    const first = arr[0];
    if (typeof first !== "object" || first === null || Array.isArray(first))
      return null;

    const candidates = [
      "id", "name", "title", "path", "slug", "key", "label",
    ];
    const obj = first as Record<string, unknown>;
    for (const field of candidates) {
      if (
        field in obj &&
        (typeof obj[field] === "string" || typeof obj[field] === "number")
      ) {
        return field;
      }
    }
    return null;
  }

  private jsonBatchTitle(
    prefix: string,
    startIdx: number,
    endIdx: number,
    batch: unknown[],
    identityField: string | null,
  ): string {
    const sep = prefix ? `${prefix} > ` : "";

    if (!identityField) {
      return startIdx === endIdx
        ? `${sep}[${startIdx}]`
        : `${sep}[${startIdx}-${endIdx}]`;
    }

    const getId = (item: unknown) =>
      String((item as Record<string, unknown>)[identityField]);

    if (batch.length === 1) {
      return `${sep}${getId(batch[0])}`;
    }
    if (batch.length <= 3) {
      return sep + batch.map(getId).join(", ");
    }
    return `${sep}${getId(batch[0])}\u2026${getId(batch[batch.length - 1])}`;
  }

  private chunkJSONArray(
    arr: unknown[],
    path: string[],
    chunks: Chunk[],
    maxChunkBytes: number,
  ): void {
    const prefix = path.length > 0 ? path.join(" > ") : "(root)";
    const identityField = this.findIdentityField(arr);

    let batch: unknown[] = [];
    let batchStart = 0;

    const flushBatch = (batchEnd: number) => {
      if (batch.length === 0) return;
      const title = this.jsonBatchTitle(
        prefix, batchStart, batchEnd, batch, identityField,
      );
      chunks.push({
        title,
        content: JSON.stringify(batch, null, 2),
        hasCode: true,
      });
    };

    for (let i = 0; i < arr.length; i++) {
      batch.push(arr[i]);
      const candidate = JSON.stringify(batch, null, 2);

      if (
        Buffer.byteLength(candidate) > maxChunkBytes &&
        batch.length > 1
      ) {
        batch.pop();
        flushBatch(i - 1);
        batch = [arr[i]];
        batchStart = i;
      }
    }

    flushBatch(batchStart + batch.length - 1);
  }

  private buildTitle(
    headingStack: Array<{ level: number; text: string }>,
    currentHeading: string,
  ): string {
    if (headingStack.length === 0) {
      return currentHeading || "Untitled";
    }
    return headingStack.map((h) => h.text).join(" > ");
  }
}
