/**
 * SessionStore — ES-backed session persistence for context-mode-es.
 *
 * Async replacement for the synchronous SQLite-backed SessionDB.
 * Preserves all public method behavior: dedup, eviction, ordering,
 * resume lifecycle, and cleanup semantics.
 *
 * Uses a single ES index per project with a `doc_type` discriminator
 * for event, meta, and resume documents.
 *
 * Reference: plans/merged/file_and_function_mapping/merged_src_session_db_v1.md
 */

import type { Client } from "@elastic/elasticsearch";
import type { SessionEvent } from "../types.js";
import { createHash } from "node:crypto";
import { ensureIndex } from "../es-base.js";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

/** A stored event document from ES. */
export interface StoredEvent {
  /** ES document _id (string, not number like SQLite autoincrement). */
  id: string;
  session_id: string;
  type: string;
  category: string;
  priority: number;
  data: string;
  source_hook: string;
  created_at: string;
  data_hash: string;
  seq: number;
}

/** Session metadata document from ES. */
export interface SessionMeta {
  session_id: string;
  project_dir: string;
  started_at: string;
  last_event_at: string | null;
  event_count: number;
  compact_count: number;
  next_seq: number;
}

/** Resume snapshot document from ES. */
export interface ResumeRow {
  snapshot: string;
  event_count: number;
  consumed: number;
}

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const MAX_EVENTS_PER_SESSION = 1000;
const DEDUP_WINDOW = 5;
const OCC_RETRIES = 3;

// ─────────────────────────────────────────────────────────
// Index mapping
// ─────────────────────────────────────────────────────────

const SESSION_MAPPINGS = {
  properties: {
    doc_type: { type: "keyword" as const },
    session_id: { type: "keyword" as const },
    // Event fields
    type: { type: "keyword" as const },
    category: { type: "keyword" as const },
    priority: { type: "integer" as const },
    data: { type: "text" as const, index: false },
    source_hook: { type: "keyword" as const },
    created_at: { type: "date" as const },
    data_hash: { type: "keyword" as const },
    seq: { type: "long" as const },
    // Meta fields
    project_dir: { type: "keyword" as const },
    started_at: { type: "date" as const },
    last_event_at: { type: "date" as const },
    event_count: { type: "integer" as const },
    compact_count: { type: "integer" as const },
    next_seq: { type: "long" as const },
    // Resume fields
    snapshot: { type: "text" as const, index: false },
    consumed: { type: "integer" as const },
  },
};

// ─────────────────────────────────────────────────────────
// SessionStore
// ─────────────────────────────────────────────────────────

export class SessionStore {
  private constructor(
    private client: Client,
    private index: string,
  ) {}

  /**
   * Create a SessionStore with an ensured ES index.
   * Use this instead of `new SessionStore()`.
   */
  static async create(
    client: Client,
    indexName: string,
  ): Promise<SessionStore> {
    await ensureIndex(indexName, SESSION_MAPPINGS);
    return new SessionStore(client, indexName);
  }

  // ── Helpers ──

  private metaId(sessionId: string): string {
    return `${sessionId}:meta`;
  }

  private resumeId(sessionId: string): string {
    return `${sessionId}:resume`;
  }

  private eventId(sessionId: string, seq: number): string {
    return `${sessionId}:event:${String(seq).padStart(10, "0")}`;
  }

  // ═══════════════════════════════════════════
  // Events
  // ═══════════════════════════════════════════

  /**
   * Insert a session event with deduplication and FIFO eviction.
   *
   * Uses OCC (optimistic concurrency control) on the meta document
   * to approximate SQLite's transaction guarantees. Retries on conflict.
   */
  async insertEvent(
    sessionId: string,
    event: SessionEvent,
    sourceHook: string = "PostToolUse",
  ): Promise<void> {
    const dataHash = createHash("sha256")
      .update(event.data)
      .digest("hex")
      .slice(0, 16)
      .toUpperCase();

    for (let attempt = 0; attempt < OCC_RETRIES; attempt++) {
      try {
        await this._insertEventOnce(sessionId, event, sourceHook, dataHash);
        return;
      } catch (err: unknown) {
        const isConflict =
          err != null &&
          typeof err === "object" &&
          "statusCode" in err &&
          (err as { statusCode: number }).statusCode === 409;
        if (!isConflict || attempt === OCC_RETRIES - 1) throw err;
        // Retry on OCC conflict
      }
    }
  }

  private async _insertEventOnce(
    sessionId: string,
    event: SessionEvent,
    sourceHook: string,
    dataHash: string,
  ): Promise<void> {
    // 1. Read meta (with seq_no/primary_term for OCC)
    let meta: SessionMeta;
    let seqNo: number;
    let primaryTerm: number;

    try {
      const metaResult = await this.client.get<SessionMeta>({
        index: this.index,
        id: this.metaId(sessionId),
      });
      meta = metaResult._source!;
      seqNo = metaResult._seq_no!;
      primaryTerm = metaResult._primary_term!;
    } catch (err: unknown) {
      if (this.isNotFound(err)) {
        // No meta yet — auto-create it (matches SQLite behavior where
        // updateMetaLastEvent is a no-op for non-existent sessions,
        // but we create meta to track seq)
        await this.ensureSession(sessionId, "");
        const metaResult = await this.client.get<SessionMeta>({
          index: this.index,
          id: this.metaId(sessionId),
        });
        meta = metaResult._source!;
        seqNo = metaResult._seq_no!;
        primaryTerm = metaResult._primary_term!;
      } else {
        throw err;
      }
    }

    // 2. Dedup check: same type + data_hash in last DEDUP_WINDOW events
    const recentResult = await this.client.search({
      index: this.index,
      size: DEDUP_WINDOW,
      query: {
        bool: {
          filter: [
            { term: { doc_type: "event" } },
            { term: { session_id: sessionId } },
          ],
        },
      },
      sort: [{ seq: "desc" }],
      _source: ["type", "data_hash"],
    });

    const isDuplicate = recentResult.hits.hits.some((hit) => {
      const src = hit._source as { type: string; data_hash: string };
      return src.type === event.type && src.data_hash === dataHash;
    });
    if (isDuplicate) return;

    // 3. Count + evict if needed
    const countResult = await this.client.count({
      index: this.index,
      query: {
        bool: {
          filter: [
            { term: { doc_type: "event" } },
            { term: { session_id: sessionId } },
          ],
        },
      },
    });

    if (countResult.count >= MAX_EVENTS_PER_SESSION) {
      // Evict lowest-priority, then oldest (lowest seq)
      const evictResult = await this.client.search({
        index: this.index,
        size: 1,
        query: {
          bool: {
            filter: [
              { term: { doc_type: "event" } },
              { term: { session_id: sessionId } },
            ],
          },
        },
        sort: [{ priority: "asc" }, { seq: "asc" }],
        _source: false,
      });
      if (evictResult.hits.hits.length > 0) {
        await this.client.delete({
          index: this.index,
          id: evictResult.hits.hits[0]._id!,
          refresh: true,
        });
      }
    }

    // 4. Index new event
    const nextSeq = meta.next_seq;
    await this.client.index({
      index: this.index,
      id: this.eventId(sessionId, nextSeq),
      document: {
        doc_type: "event",
        session_id: sessionId,
        type: event.type,
        category: event.category,
        priority: event.priority,
        data: event.data,
        source_hook: sourceHook,
        created_at: new Date().toISOString(),
        data_hash: dataHash,
        seq: nextSeq,
      },
      refresh: true,
    });

    // 5. Update meta with OCC guard
    await this.client.update({
      index: this.index,
      id: this.metaId(sessionId),
      doc: {
        last_event_at: new Date().toISOString(),
        event_count: meta.event_count + 1,
        next_seq: nextSeq + 1,
      },
      if_seq_no: seqNo,
      if_primary_term: primaryTerm,
      refresh: true,
    });
  }

  /**
   * Retrieve events for a session with optional filtering.
   */
  async getEvents(
    sessionId: string,
    opts?: { type?: string; minPriority?: number; limit?: number },
  ): Promise<StoredEvent[]> {
    const limit = opts?.limit ?? 1000;
    const filters: Array<Record<string, unknown>> = [
      { term: { doc_type: "event" } },
      { term: { session_id: sessionId } },
    ];

    if (opts?.type) {
      filters.push({ term: { type: opts.type } });
    }
    if (opts?.minPriority !== undefined) {
      filters.push({ range: { priority: { gte: opts.minPriority } } });
    }

    const result = await this.client.search({
      index: this.index,
      size: limit,
      query: { bool: { filter: filters } },
      sort: [{ seq: "asc" }],
    });

    return result.hits.hits.map((hit) => {
      const src = hit._source as Record<string, unknown>;
      return {
        id: hit._id!,
        session_id: src.session_id as string,
        type: src.type as string,
        category: src.category as string,
        priority: src.priority as number,
        data: src.data as string,
        source_hook: src.source_hook as string,
        created_at: src.created_at as string,
        data_hash: src.data_hash as string,
        seq: src.seq as number,
      };
    });
  }

  /**
   * Get the total event count for a session.
   */
  async getEventCount(sessionId: string): Promise<number> {
    const result = await this.client.count({
      index: this.index,
      query: {
        bool: {
          filter: [
            { term: { doc_type: "event" } },
            { term: { session_id: sessionId } },
          ],
        },
      },
    });
    return result.count;
  }

  // ═══════════════════════════════════════════
  // Meta
  // ═══════════════════════════════════════════

  /**
   * Ensure a session metadata entry exists. Idempotent (catches 409).
   */
  async ensureSession(
    sessionId: string,
    projectDir: string,
  ): Promise<void> {
    try {
      await this.client.create({
        index: this.index,
        id: this.metaId(sessionId),
        document: {
          doc_type: "meta",
          session_id: sessionId,
          project_dir: projectDir,
          started_at: new Date().toISOString(),
          last_event_at: null,
          event_count: 0,
          compact_count: 0,
          next_seq: 0,
        },
        refresh: true,
      });
    } catch (err: unknown) {
      // 409 = already exists — idempotent (mirrors INSERT OR IGNORE)
      if (!this.isConflict(err)) throw err;
    }
  }

  /**
   * Get session statistics/metadata.
   */
  async getSessionStats(sessionId: string): Promise<SessionMeta | null> {
    try {
      const result = await this.client.get<SessionMeta>({
        index: this.index,
        id: this.metaId(sessionId),
      });
      return result._source ?? null;
    } catch (err: unknown) {
      if (this.isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * Increment the compact_count for a session (atomic via painless script).
   */
  async incrementCompactCount(sessionId: string): Promise<void> {
    await this.client.update({
      index: this.index,
      id: this.metaId(sessionId),
      script: {
        source: "ctx._source.compact_count += 1",
        lang: "painless",
      },
      refresh: true,
    });
  }

  // ═══════════════════════════════════════════
  // Resume
  // ═══════════════════════════════════════════

  /**
   * Upsert a resume snapshot. Full document replace resets consumed to 0.
   */
  async upsertResume(
    sessionId: string,
    snapshot: string,
    eventCount?: number,
  ): Promise<void> {
    await this.client.index({
      index: this.index,
      id: this.resumeId(sessionId),
      document: {
        doc_type: "resume",
        session_id: sessionId,
        snapshot,
        event_count: eventCount ?? 0,
        created_at: new Date().toISOString(),
        consumed: 0,
      },
      refresh: true,
    });
  }

  /**
   * Retrieve the resume snapshot for a session.
   */
  async getResume(sessionId: string): Promise<ResumeRow | null> {
    try {
      const result = await this.client.get({
        index: this.index,
        id: this.resumeId(sessionId),
      });
      const src = result._source as Record<string, unknown>;
      return {
        snapshot: src.snapshot as string,
        event_count: src.event_count as number,
        consumed: src.consumed as number,
      };
    } catch (err: unknown) {
      if (this.isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * Mark the resume snapshot as consumed.
   */
  async markResumeConsumed(sessionId: string): Promise<void> {
    try {
      await this.client.update({
        index: this.index,
        id: this.resumeId(sessionId),
        doc: { consumed: 1 },
        refresh: true,
      });
    } catch (err: unknown) {
      if (this.isNotFound(err)) return; // No resume to mark
      throw err;
    }
  }

  // ═══════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════

  /**
   * Delete all data for a session (events, meta, resume).
   */
  async deleteSession(sessionId: string): Promise<void> {
    // Delete all events via deleteByQuery
    await this.client.deleteByQuery({
      index: this.index,
      query: {
        bool: {
          filter: [
            { term: { doc_type: "event" } },
            { term: { session_id: sessionId } },
          ],
        },
      },
      refresh: true,
    });

    // Delete meta and resume (ignore 404)
    for (const id of [this.metaId(sessionId), this.resumeId(sessionId)]) {
      try {
        await this.client.delete({ index: this.index, id, refresh: true });
      } catch (err: unknown) {
        if (!this.isNotFound(err)) throw err;
      }
    }
  }

  /**
   * Remove sessions older than maxAgeDays. Returns count of deleted sessions.
   */
  async cleanupOldSessions(maxAgeDays: number = 7): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    const cutoffISO = cutoff.toISOString();

    const result = await this.client.search({
      index: this.index,
      size: 1000,
      query: {
        bool: {
          filter: [
            { term: { doc_type: "meta" } },
            { range: { started_at: { lt: cutoffISO } } },
          ],
        },
      },
      _source: ["session_id"],
    });

    const oldSessions = result.hits.hits.map(
      (hit) => (hit._source as { session_id: string }).session_id,
    );

    for (const sid of oldSessions) {
      await this.deleteSession(sid);
    }

    return oldSessions.length;
  }

  /**
   * No-op for ES (client lifecycle managed by es-base.ts).
   * Provided for API compatibility with SessionDB.close().
   */
  async close(): Promise<void> {
    // Client lifecycle is managed by closeClient() in es-base.ts
  }

  /**
   * Delete the entire index. Used for test cleanup.
   */
  async cleanup(): Promise<void> {
    try {
      await this.client.indices.delete({
        index: this.index,
        ignore_unavailable: true,
      });
    } catch {
      // Swallow errors in cleanup path
    }
  }

  // ── Error helpers ──

  private isNotFound(err: unknown): boolean {
    return (
      err != null &&
      typeof err === "object" &&
      "statusCode" in err &&
      (err as { statusCode: number }).statusCode === 404
    );
  }

  private isConflict(err: unknown): boolean {
    return (
      err != null &&
      typeof err === "object" &&
      "statusCode" in err &&
      (err as { statusCode: number }).statusCode === 409
    );
  }
}
