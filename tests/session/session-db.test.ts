import { strict as assert } from "node:assert";
import { afterAll, describe, test } from "vitest";
import {
  createTestSessionStore,
  cleanupIndex,
  refreshIndex,
} from "../shared/es-test-helpers.js";
import type { SessionStore } from "../../src/session/es-db.js";

const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const fn of cleanups) {
    try {
      await fn();
    } catch {
      // ignore cleanup errors
    }
  }
});

/** Create a temporary SessionStore that auto-registers for cleanup. */
async function createTestStore(): Promise<SessionStore> {
  const { store, indexName } = await createTestSessionStore();
  cleanups.push(() => cleanupIndex(indexName));
  return store;
}

/** Create a minimal session event for testing. */
function makeEvent(overrides: Partial<{
  type: string;
  category: string;
  data: string;
  priority: number;
  data_hash: string;
}> = {}) {
  return {
    type: overrides.type ?? "file",
    category: overrides.category ?? "file",
    data: overrides.data ?? "/project/src/server.ts",
    priority: overrides.priority ?? 2,
    data_hash: overrides.data_hash ?? "",
  };
}

// ════════════════════════════════════════════
// SLICE 1: SCHEMA INITIALIZATION
// ════════════════════════════════════════════

describe("Schema", () => {
  test("creates store and initializes index without error", async () => {
    const store = await createTestStore();
    // If we got here, the index was created and mappings were applied.
    // Verify by checking that a count query works.
    const count = await store.getEventCount("non-existent");
    assert.equal(count, 0);
  });
});

// ════════════════════════════════════════════
// SLICE 2: INSERT AND RETRIEVE EVENTS
// ════════════════════════════════════════════

describe("Insert & Retrieve", () => {
  test("insertEvent stores event and retrieves it with getEvents", async () => {
    const store = await createTestStore();
    const sid = "sess-1";
    const event = makeEvent({ data: "/project/src/main.ts" });

    await store.insertEvent(sid, event, "PostToolUse");

    const events = await store.getEvents(sid);
    assert.equal(events.length, 1);
    assert.equal(events[0].session_id, sid);
    assert.equal(events[0].type, "file");
    assert.equal(events[0].category, "file");
    assert.equal(events[0].data, "/project/src/main.ts");
    assert.equal(events[0].priority, 2);
    assert.equal(events[0].source_hook, "PostToolUse");
    assert.ok(typeof events[0].id === "string" && events[0].id.length > 0);
    assert.ok(events[0].created_at.length > 0);
    assert.ok(events[0].data_hash.length > 0);
  });
});

// ════════════════════════════════════════════
// SLICE 3: FILTER BY TYPE
// ════════════════════════════════════════════

describe("Filter by type", () => {
  test("getEvents filters by type", async () => {
    const store = await createTestStore();
    const sid = "sess-2";

    await store.insertEvent(sid, makeEvent({ type: "file", data: "a.ts" }));
    await store.insertEvent(sid, makeEvent({ type: "git", data: "commit" }));
    await store.insertEvent(sid, makeEvent({ type: "file", data: "b.ts" }));

    const fileEvents = await store.getEvents(sid, { type: "file" });
    assert.equal(fileEvents.length, 2);
    assert.ok(fileEvents.every(e => e.type === "file"));

    const gitEvents = await store.getEvents(sid, { type: "git" });
    assert.equal(gitEvents.length, 1);
    assert.equal(gitEvents[0].data, "commit");
  });
});

// ════════════════════════════════════════════
// SLICE 4: FILTER BY MIN PRIORITY
// ════════════════════════════════════════════

describe("Filter by minPriority", () => {
  test("getEvents filters by minPriority", async () => {
    const store = await createTestStore();
    const sid = "sess-3";

    await store.insertEvent(sid, makeEvent({ type: "file", data: "low.ts", priority: 1 }));
    await store.insertEvent(sid, makeEvent({ type: "git", data: "medium", priority: 2 }));
    await store.insertEvent(sid, makeEvent({ type: "error", data: "high", priority: 3 }));
    await store.insertEvent(sid, makeEvent({ type: "decision", data: "critical", priority: 4 }));

    const highAndAbove = await store.getEvents(sid, { minPriority: 3 });
    assert.equal(highAndAbove.length, 2);
    assert.ok(highAndAbove.every(e => e.priority >= 3));

    const allEvents = await store.getEvents(sid, { minPriority: 1 });
    assert.equal(allEvents.length, 4);
  });
});

// ════════════════════════════════════════════
// SLICE 5: DEDUPLICATION
// ════════════════════════════════════════════

describe("Deduplication", () => {
  test("deduplication: inserting same type+data twice only stores once", async () => {
    const store = await createTestStore();
    const sid = "sess-4";
    const event = makeEvent({ type: "file", data: "/project/src/same.ts" });

    await store.insertEvent(sid, event);
    await store.insertEvent(sid, event); // duplicate

    const events = await store.getEvents(sid);
    assert.equal(events.length, 1, `Expected 1 event after dedup, got ${events.length}`);
  });

  test("deduplication: different data is not deduplicated", async () => {
    const store = await createTestStore();
    const sid = "sess-4b";

    await store.insertEvent(sid, makeEvent({ type: "file", data: "a.ts" }));
    await store.insertEvent(sid, makeEvent({ type: "file", data: "b.ts" }));

    const events = await store.getEvents(sid);
    assert.equal(events.length, 2);
  });

  test("deduplication: same data but different type is not deduplicated", async () => {
    const store = await createTestStore();
    const sid = "sess-4c";

    await store.insertEvent(sid, makeEvent({ type: "file", data: "x.ts" }));
    await store.insertEvent(sid, makeEvent({ type: "file_read", data: "x.ts" }));

    const events = await store.getEvents(sid);
    assert.equal(events.length, 2);
  });

  test("deduplication: duplicate beyond window of 5 is stored again", async () => {
    const store = await createTestStore();
    const sid = "sess-4d";
    const dupEvent = makeEvent({ type: "file", data: "dup.ts" });

    await store.insertEvent(sid, dupEvent);

    // Insert 5 different events to push the original out of the dedup window
    for (let i = 0; i < 5; i++) {
      await store.insertEvent(sid, makeEvent({ type: "file", data: `filler-${i}.ts` }));
    }

    // Now insert the same event again - should succeed since it's outside the window
    await store.insertEvent(sid, dupEvent);

    const events = await store.getEvents(sid);
    const dupEvents = events.filter(e => e.data === "dup.ts");
    assert.equal(dupEvents.length, 2, `Expected 2 dup.ts events (original + re-insert), got ${dupEvents.length}`);
  });
});

// ════════════════════════════════════════════
// SLICE 6: MAX EVENTS & FIFO EVICTION
// ════════════════════════════════════════════

describe("Max Events & FIFO Eviction", () => {
  test("max 1000 events with FIFO eviction of lowest priority", async () => {
    const store = await createTestStore();
    const sid = "sess-5";

    // Insert 1000 events at priority 2
    for (let i = 0; i < 1000; i++) {
      await store.insertEvent(sid, makeEvent({ type: "file", data: `file-${i}.ts`, priority: 2 }));
    }
    assert.equal(await store.getEventCount(sid), 1000);

    // Insert one more at priority 3 - should evict the lowest priority (first p2 event)
    await store.insertEvent(sid, makeEvent({ type: "git", data: "new-event", priority: 3 }));
    assert.equal(await store.getEventCount(sid), 1000);

    // The high-priority event should be present
    const gitEvents = await store.getEvents(sid, { type: "git" });
    assert.equal(gitEvents.length, 1);
    assert.equal(gitEvents[0].data, "new-event");

    // The evicted event should be the lowest priority + oldest (file-0.ts)
    const allEvents = await store.getEvents(sid);
    const hasFile0 = allEvents.some(e => e.data === "file-0.ts");
    assert.equal(hasFile0, false, "file-0.ts should have been evicted");
  }, 120_000); // Allow extra time for 1001 ES operations
});

// ════════════════════════════════════════════
// SLICE 7: ENSURE SESSION
// ════════════════════════════════════════════

describe("Session Meta", () => {
  test("ensureSession creates meta entry", async () => {
    const store = await createTestStore();
    const sid = "sess-6";

    await store.ensureSession(sid, "/project/root");

    const stats = await store.getSessionStats(sid);
    assert.ok(stats !== null, "Session stats should exist");
    assert.equal(stats!.session_id, sid);
    assert.equal(stats!.project_dir, "/project/root");
    assert.equal(stats!.event_count, 0);
    assert.equal(stats!.compact_count, 0);
    assert.ok(stats!.started_at.length > 0);
  });

  test("ensureSession is idempotent", async () => {
    const store = await createTestStore();
    const sid = "sess-6b";

    await store.ensureSession(sid, "/project/root");
    await store.ensureSession(sid, "/different/path"); // should not overwrite

    const stats = await store.getSessionStats(sid);
    assert.equal(stats!.project_dir, "/project/root");
  });
});

// ════════════════════════════════════════════
// SLICE 8: SESSION STATS
// ════════════════════════════════════════════

describe("Session Stats", () => {
  test("getSessionStats returns correct counts after insertEvent", async () => {
    const store = await createTestStore();
    const sid = "sess-7";

    await store.ensureSession(sid, "/project");
    await store.insertEvent(sid, makeEvent({ data: "a.ts" }));
    await store.insertEvent(sid, makeEvent({ data: "b.ts" }));
    await store.insertEvent(sid, makeEvent({ data: "c.ts" }));

    const stats = await store.getSessionStats(sid);
    assert.ok(stats !== null);
    assert.equal(stats!.event_count, 3);
    assert.ok(stats!.last_event_at !== null, "last_event_at should be set");
  });

  test("getSessionStats returns null for non-existent session", async () => {
    const store = await createTestStore();
    const stats = await store.getSessionStats("no-such-session");
    assert.equal(stats, null);
  });
});

// ════════════════════════════════════════════
// SLICE 9: INCREMENT COMPACT COUNT
// ════════════════════════════════════════════

describe("Compact Count", () => {
  test("incrementCompactCount increments correctly", async () => {
    const store = await createTestStore();
    const sid = "sess-8";

    await store.ensureSession(sid, "/project");

    await store.incrementCompactCount(sid);
    let stats = await store.getSessionStats(sid);
    assert.equal(stats!.compact_count, 1);

    await store.incrementCompactCount(sid);
    stats = await store.getSessionStats(sid);
    assert.equal(stats!.compact_count, 2);

    await store.incrementCompactCount(sid);
    await store.incrementCompactCount(sid);
    stats = await store.getSessionStats(sid);
    assert.equal(stats!.compact_count, 4);
  });
});

// ════════════════════════════════════════════
// SLICE 10: UPSERT RESUME
// ════════════════════════════════════════════

describe("Resume", () => {
  test("upsertResume stores and retrieves snapshot", async () => {
    const store = await createTestStore();
    const sid = "sess-9";
    const snapshot = "<resume>session context here</resume>";

    await store.upsertResume(sid, snapshot, 42);

    const resume = await store.getResume(sid);
    assert.ok(resume !== null);
    assert.equal(resume!.snapshot, snapshot);
    assert.equal(resume!.event_count, 42);
    assert.equal(resume!.consumed, 0);
  });

  test("upsertResume overwrites existing snapshot and resets consumed", async () => {
    const store = await createTestStore();
    const sid = "sess-9b";

    await store.upsertResume(sid, "<resume>v1</resume>", 10);
    await store.markResumeConsumed(sid);

    // Verify consumed is set
    let resume = await store.getResume(sid);
    assert.equal(resume!.consumed, 1);

    // Upsert again - should reset consumed
    await store.upsertResume(sid, "<resume>v2</resume>", 20);
    resume = await store.getResume(sid);
    assert.equal(resume!.snapshot, "<resume>v2</resume>");
    assert.equal(resume!.event_count, 20);
    assert.equal(resume!.consumed, 0);
  });
});

// ════════════════════════════════════════════
// SLICE 11: MARK RESUME CONSUMED
// ════════════════════════════════════════════

describe("Resume Consumed", () => {
  test("markResumeConsumed sets consumed flag", async () => {
    const store = await createTestStore();
    const sid = "sess-10";

    await store.upsertResume(sid, "<resume>data</resume>", 5);

    await store.markResumeConsumed(sid);

    const resume = await store.getResume(sid);
    assert.ok(resume !== null);
    assert.equal(resume!.consumed, 1);
  });
});

// ════════════════════════════════════════════
// SLICE 12: GET RESUME FOR NON-EXISTENT SESSION
// ════════════════════════════════════════════

describe("Resume Edge Cases", () => {
  test("getResume returns null for non-existent session", async () => {
    const store = await createTestStore();
    const resume = await store.getResume("no-such-session");
    assert.equal(resume, null);
  });
});

// ════════════════════════════════════════════
// SLICE 13: DELETE SESSION
// ════════════════════════════════════════════

describe("Delete Session", () => {
  test("deleteSession removes all events, meta, and resume", async () => {
    const store = await createTestStore();
    const sid = "sess-11";

    // Create session with events, meta, and resume
    await store.ensureSession(sid, "/project");
    await store.insertEvent(sid, makeEvent({ data: "a.ts" }));
    await store.insertEvent(sid, makeEvent({ data: "b.ts" }));
    await store.upsertResume(sid, "<resume>snapshot</resume>", 2);

    // Verify data exists
    assert.equal(await store.getEventCount(sid), 2);
    assert.ok((await store.getSessionStats(sid)) !== null);
    assert.ok((await store.getResume(sid)) !== null);

    // Delete
    await store.deleteSession(sid);

    // Verify all gone
    assert.equal(await store.getEventCount(sid), 0);
    assert.equal(await store.getSessionStats(sid), null);
    assert.equal(await store.getResume(sid), null);
  });

  test("deleteSession does not affect other sessions", async () => {
    const store = await createTestStore();

    await store.ensureSession("keep", "/project");
    await store.insertEvent("keep", makeEvent({ data: "keep.ts" }));

    await store.ensureSession("delete", "/project");
    await store.insertEvent("delete", makeEvent({ data: "delete.ts" }));

    await store.deleteSession("delete");

    // "keep" session should be untouched
    assert.equal(await store.getEventCount("keep"), 1);
    assert.ok((await store.getSessionStats("keep")) !== null);

    // "delete" session should be gone
    assert.equal(await store.getEventCount("delete"), 0);
  });
});

// ════════════════════════════════════════════
// SLICE 14: CLEANUP OLD SESSIONS
// ════════════════════════════════════════════

describe("Cleanup Old Sessions", () => {
  test("cleanupOldSessions does not remove fresh sessions", async () => {
    const store = await createTestStore();

    await store.ensureSession("old-session", "/project/old");
    await store.insertEvent("old-session", makeEvent({ data: "old.ts" }));
    await store.upsertResume("old-session", "<resume>old</resume>", 1);

    await store.ensureSession("new-session", "/project/new");
    await store.insertEvent("new-session", makeEvent({ data: "new.ts" }));

    // Sessions created just now should NOT be cleaned up with maxAgeDays=7
    const deletedCount = await store.cleanupOldSessions(7);
    assert.equal(deletedCount, 0, "Fresh sessions should not be cleaned up");

    // Both sessions should still exist
    assert.ok((await store.getSessionStats("old-session")) !== null);
    assert.ok((await store.getSessionStats("new-session")) !== null);
  });

  test("cleanupOldSessions returns count of deleted sessions", async () => {
    const store = await createTestStore();

    // Verify it returns 0 for empty index
    const count = await store.cleanupOldSessions();
    assert.equal(count, 0);
  });
});

// ════════════════════════════════════════════
// ADDITIONAL: getEventCount
// ════════════════════════════════════════════

describe("getEventCount", () => {
  test("getEventCount returns correct count", async () => {
    const store = await createTestStore();
    const sid = "sess-count";

    assert.equal(await store.getEventCount(sid), 0);

    await store.insertEvent(sid, makeEvent({ data: "a.ts" }));
    assert.equal(await store.getEventCount(sid), 1);

    await store.insertEvent(sid, makeEvent({ data: "b.ts" }));
    await store.insertEvent(sid, makeEvent({ data: "c.ts" }));
    assert.equal(await store.getEventCount(sid), 3);
  });
});

// ════════════════════════════════════════════
// ADDITIONAL: Combined type + priority filter
// ════════════════════════════════════════════

describe("Combined Filters", () => {
  test("getEvents filters by both type and minPriority", async () => {
    const store = await createTestStore();
    const sid = "sess-combo";

    await store.insertEvent(sid, makeEvent({ type: "file", data: "low-file.ts", priority: 1 }));
    await store.insertEvent(sid, makeEvent({ type: "file", data: "high-file.ts", priority: 3 }));
    await store.insertEvent(sid, makeEvent({ type: "git", data: "low-git", priority: 1 }));
    await store.insertEvent(sid, makeEvent({ type: "git", data: "high-git", priority: 3 }));

    const highFiles = await store.getEvents(sid, { type: "file", minPriority: 2 });
    assert.equal(highFiles.length, 1);
    assert.equal(highFiles[0].data, "high-file.ts");
  });
});

// ════════════════════════════════════════════
// ADDITIONAL: Limit parameter
// ════════════════════════════════════════════

describe("Limit", () => {
  test("getEvents respects limit parameter", async () => {
    const store = await createTestStore();
    const sid = "sess-limit";

    for (let i = 0; i < 10; i++) {
      await store.insertEvent(sid, makeEvent({ data: `file-${i}.ts` }));
    }

    const limited = await store.getEvents(sid, { limit: 3 });
    assert.equal(limited.length, 3);
    // Should be the first 3 (ordered by seq ASC)
    assert.equal(limited[0].data, "file-0.ts");
    assert.equal(limited[2].data, "file-2.ts");
  });
});
