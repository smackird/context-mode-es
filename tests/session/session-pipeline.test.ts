import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { afterAll, describe, test } from "vitest";
import { extractEvents, extractUserEvents } from "../../src/session/extract.js";
import { buildResumeSnapshot } from "../../src/session/snapshot.js";
import {
  createTestSessionStore,
  cleanupIndex,
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

// ════════════════════════════════════════════
// TEST 1: Full pipeline -- Edit + Git + CLAUDE.md -> Snapshot -> Resume injection
// ════════════════════════════════════════════

describe("1. Full Pipeline: Edit + Git + CLAUDE.md", () => {
  test("full pipeline: extract -> store -> snapshot -> resume lifecycle", async () => {
    const store = await createTestStore();
    const sid = `pipeline-${randomUUID()}`;
    await store.ensureSession(sid, "/project");

    // Step 1: Extract events from multiple tool calls
    const editEvents = extractEvents({
      tool_name: "Edit",
      tool_input: {
        file_path: "/project/src/server.ts",
        old_string: 'const VERSION = "0.9.21"',
        new_string: 'const VERSION = "0.9.22"',
      },
      tool_response: "File edited successfully",
    });

    const gitEvents = extractEvents({
      tool_name: "Bash",
      tool_input: { command: "git checkout -b feature/session-continuity" },
      tool_response: "Switched to a new branch 'feature/session-continuity'",
    });

    const claudeMdEvents = extractEvents({
      tool_name: "Read",
      tool_input: { file_path: "/project/CLAUDE.md" },
      tool_response: "# Rules\n- Never push without approval\n- Always use TypeScript",
    });

    // Verify extraction produced events
    assert.ok(editEvents.length >= 1, "Edit should produce at least 1 event");
    assert.ok(gitEvents.length >= 1, "Git checkout should produce at least 1 event");
    assert.ok(claudeMdEvents.length >= 2, "CLAUDE.md read should produce rule + file_read events");

    // Step 2: Insert all events into store
    for (const ev of editEvents) await store.insertEvent(sid, ev, "PostToolUse");
    for (const ev of gitEvents) await store.insertEvent(sid, ev, "PostToolUse");
    for (const ev of claudeMdEvents) await store.insertEvent(sid, ev, "PostToolUse");

    // Step 3: Build snapshot from stored events
    const storedEvents = await store.getEvents(sid);
    const snapshot = buildResumeSnapshot(storedEvents);

    // Step 4: Upsert resume
    await store.upsertResume(sid, snapshot, storedEvents.length);

    // Step 5: Verify resume XML structure
    assert.ok(snapshot.includes("<active_files>"), "resume should contain <active_files>");
    assert.ok(snapshot.includes("<rules>"), "resume should contain <rules>");
    assert.ok(snapshot.includes("<environment>"), "resume should contain <environment>");

    // Step 6: Verify budget constraint
    const byteSize = Buffer.byteLength(snapshot);
    assert.ok(byteSize <= 2048, `resume should be <= 2048 bytes, got ${byteSize}`);

    // Step 7: Verify XML wrapper
    assert.ok(snapshot.startsWith("<session_resume"), "should start with <session_resume");
    assert.ok(snapshot.endsWith("</session_resume>"), "should end with </session_resume>");

    // Step 8: Verify resume consumed lifecycle
    const resume = await store.getResume(sid);
    assert.ok(resume !== null, "resume should exist");
    assert.equal(resume!.consumed, 0, "resume should not be consumed yet");

    await store.markResumeConsumed(sid);
    const consumed = await store.getResume(sid);
    assert.equal(consumed!.consumed, 1, "resume should be consumed after marking");
  });
});

// ════════════════════════════════════════════
// TEST 2: User decisions preserved in resume
// ════════════════════════════════════════════

describe("2. User Decisions Preserved in Resume", () => {
  test("user decisions are preserved in resume snapshot", async () => {
    const store = await createTestStore();
    const sid = `decisions-${randomUUID()}`;
    await store.ensureSession(sid, "/project");

    // Extract decision event from user message
    const decisionEvents = extractUserEvents("never push to main without asking");
    assert.ok(decisionEvents.length >= 1, "should extract at least 1 decision event");

    const decisionEvent = decisionEvents.find(e => e.type === "decision");
    assert.ok(decisionEvent, "should have a decision event");

    // Insert the decision event
    await store.insertEvent(sid, decisionEvent!, "UserPromptSubmit");

    // Build snapshot
    const storedEvents = await store.getEvents(sid);
    const snapshot = buildResumeSnapshot(storedEvents, { maxBytes: 4096 });

    // Verify the snapshot contains the decision text or rules/decisions section
    const hasDecisions = snapshot.includes("<decisions>") || snapshot.includes("<rules>");
    assert.ok(hasDecisions, "snapshot should contain <decisions> or <rules> section");
    assert.ok(
      snapshot.includes("never push to main") || snapshot.includes("push to main"),
      "snapshot should contain the decision text",
    );
  });
});

// ════════════════════════════════════════════
// TEST 3: Deduplication works end-to-end
// ════════════════════════════════════════════

describe("3. Deduplication End-to-End", () => {
  test("deduplication: inserting same Edit event 5 times stores only 1", async () => {
    const store = await createTestStore();
    const sid = `dedup-${randomUUID()}`;
    await store.ensureSession(sid, "/project");

    const editInput = {
      tool_name: "Edit",
      tool_input: {
        file_path: "/project/src/store.ts",
        old_string: "const x = 1",
        new_string: "const x = 2",
      },
      tool_response: "File edited successfully",
    };

    // Extract the same events 5 times and insert each
    for (let i = 0; i < 5; i++) {
      const events = extractEvents(editInput);
      for (const ev of events) {
        await store.insertEvent(sid, ev, "PostToolUse");
      }
    }

    // Should only have 1 event due to dedup
    const count = await store.getEventCount(sid);
    assert.equal(count, 1, `expected 1 event after dedup, got ${count}`);

    // Build snapshot -- file should appear only once
    const storedEvents = await store.getEvents(sid);
    const snapshot = buildResumeSnapshot(storedEvents);
    const fileTagCount = (snapshot.match(/<file /g) || []).length;
    assert.equal(fileTagCount, 1, `expected 1 <file> tag, got ${fileTagCount}`);
  });
});

// ════════════════════════════════════════════
// TEST 4: SessionStart lifecycle: startup purges, compact injects, resume noops
// ════════════════════════════════════════════

describe("4. SessionStart Lifecycle", () => {
  test("lifecycle: old session data, new session creation, compact, resume", async () => {
    const store = await createTestStore();

    // --- Phase 1: Create an "old" session with events and resume ---
    const oldSid = "old-session";
    await store.ensureSession(oldSid, "/project/old");
    await store.insertEvent(oldSid, {
      type: "file",
      category: "file",
      data: "/project/old/legacy.ts",
      priority: 1,
    }, "PostToolUse");
    await store.upsertResume(oldSid, "<session_resume>old data</session_resume>", 1);

    // Verify old session exists
    assert.ok((await store.getSessionStats(oldSid)) !== null, "old session should exist");
    assert.ok((await store.getResume(oldSid)) !== null, "old resume should exist");

    // --- Phase 2: Simulate startup cleanup (with generous age so fresh sessions survive) ---
    const deletedCount = await store.cleanupOldSessions(7);
    assert.equal(deletedCount, 0, "fresh sessions should not be cleaned up");

    // Old session should still exist (it was just created)
    assert.ok((await store.getSessionStats(oldSid)) !== null, "old session should survive fresh cleanup");

    // --- Phase 3: Create a new "current" session ---
    const currentSid = "current-session";
    await store.ensureSession(currentSid, "/project/current");

    await store.insertEvent(currentSid, {
      type: "file",
      category: "file",
      data: "/project/current/app.ts",
      priority: 1,
    }, "PostToolUse");
    await store.insertEvent(currentSid, {
      type: "cwd",
      category: "cwd",
      data: "/project/current",
      priority: 2,
    }, "PostToolUse");

    // --- Phase 4: Simulate compact -- build snapshot and upsert resume ---
    const currentEvents = await store.getEvents(currentSid);
    const snapshot = buildResumeSnapshot(currentEvents);
    await store.upsertResume(currentSid, snapshot, currentEvents.length);
    await store.incrementCompactCount(currentSid);

    // Verify resume is retrievable
    const resume = await store.getResume(currentSid);
    assert.ok(resume !== null, "current resume should exist after compact");
    assert.equal(resume!.consumed, 0, "current resume should not be consumed");
    assert.equal(resume!.event_count, currentEvents.length, "event count should match");

    // Verify compact count incremented
    const stats = await store.getSessionStats(currentSid);
    assert.equal(stats!.compact_count, 1, "compact_count should be 1");

    // --- Phase 5: Simulate resume/continue -- consume the resume ---
    await store.markResumeConsumed(currentSid);
    const consumedResume = await store.getResume(currentSid);
    assert.equal(consumedResume!.consumed, 1, "resume should be consumed after SessionStart");

    // After consumption, a subsequent SessionStart should see consumed=1 (noop)
    const secondCheck = await store.getResume(currentSid);
    assert.equal(secondCheck!.consumed, 1, "resume should still be consumed on re-check");
  });

  test("deleteSession fully removes old session data", async () => {
    const store = await createTestStore();
    const sid = "to-delete";
    await store.ensureSession(sid, "/project");
    await store.insertEvent(sid, {
      type: "file",
      category: "file",
      data: "/project/file.ts",
      priority: 1,
    }, "PostToolUse");
    await store.upsertResume(sid, "<session_resume>snapshot</session_resume>", 1);

    // Delete it
    await store.deleteSession(sid);

    // Verify all traces are gone
    assert.equal(await store.getEventCount(sid), 0, "events should be gone");
    assert.equal(await store.getSessionStats(sid), null, "meta should be gone");
    assert.equal(await store.getResume(sid), null, "resume should be gone");
  });
});

// ════════════════════════════════════════════
// TEST 5: Budget constraint under stress
// ════════════════════════════════════════════

describe("5. Budget Constraint Under Stress", () => {
  test("budget constraint: 100+ events still produce snapshot <= 2048 bytes", async () => {
    const store = await createTestStore();
    const sid = `stress-${randomUUID()}`;
    await store.ensureSession(sid, "/project");

    // Insert 50 file events
    for (let i = 0; i < 50; i++) {
      await store.insertEvent(sid, {
        type: "file",
        category: "file",
        data: `${randomUUID()}/component.tsx`,
        priority: 1,
      }, "PostToolUse");
    }

    // Insert 20 task events
    for (let i = 0; i < 20; i++) {
      await store.insertEvent(sid, {
        type: "task",
        category: "task",
        data: `${randomUUID()} implement feature`,
        priority: 1,
      }, "PostToolUse");
    }

    // Insert 15 rule events
    for (let i = 0; i < 15; i++) {
      await store.insertEvent(sid, {
        type: "rule",
        category: "rule",
        data: `${randomUUID()} always follow convention`,
        priority: 1,
      }, "PostToolUse");
    }

    // Insert 10 error events
    for (let i = 0; i < 10; i++) {
      await store.insertEvent(sid, {
        type: "error_tool",
        category: "error",
        data: `${randomUUID()} module not found`,
        priority: 2,
      }, "PostToolUse");
    }

    // Insert 5 decision events
    for (let i = 0; i < 5; i++) {
      await store.insertEvent(sid, {
        type: "decision",
        category: "decision",
        data: `${randomUUID()} use approach`,
        priority: 2,
      }, "PostToolUse");
    }

    // Insert env, cwd, git events
    await store.insertEvent(sid, { type: "cwd", category: "cwd", data: "/project/src", priority: 2 }, "PostToolUse");
    await store.insertEvent(sid, { type: "git", category: "git", data: "branch", priority: 2 }, "PostToolUse");
    await store.insertEvent(sid, { type: "env", category: "env", data: "nvm use 20", priority: 2 }, "PostToolUse");
    await store.insertEvent(sid, { type: "intent", category: "intent", data: "implement", priority: 4 }, "PostToolUse");

    // Total: 50 + 20 + 15 + 10 + 5 + 3 + 1 = 104 events
    const totalEvents = await store.getEventCount(sid);
    assert.ok(totalEvents >= 100, `expected >= 100 events, got ${totalEvents}`);

    // Build snapshot
    const storedEvents = await store.getEvents(sid);
    const snapshot = buildResumeSnapshot(storedEvents);

    // Verify budget
    const byteSize = Buffer.byteLength(snapshot);
    assert.ok(byteSize <= 2048, `expected <= 2048 bytes, got ${byteSize}`);

    // Verify valid XML structure
    assert.ok(snapshot.startsWith("<session_resume"), "should start with <session_resume");
    assert.ok(snapshot.endsWith("</session_resume>"), "should end with </session_resume>");
  }, 120_000); // Allow extra time for 104 ES operations
});

// ════════════════════════════════════════════
// TEST 6: Empty session produces valid but empty snapshot
// ════════════════════════════════════════════

describe("6. Empty Session Snapshot", () => {
  test("empty session: 0 events produces valid XML with events_captured=0", () => {
    // Build snapshot with empty events array (no DB needed)
    const snapshot = buildResumeSnapshot([]);

    // Verify events_captured="0"
    assert.ok(snapshot.includes('events_captured="0"'), `expected events_captured="0", got: ${snapshot}`);

    // Verify valid XML wrapper
    assert.ok(snapshot.startsWith("<session_resume"), "should start with <session_resume");
    assert.ok(snapshot.endsWith("</session_resume>"), "should end with </session_resume>");
  });

  test("empty session from store: getEvents returns empty, snapshot still valid", async () => {
    const store = await createTestStore();
    const sid = `empty-${randomUUID()}`;
    await store.ensureSession(sid, "/project");

    // No events inserted
    const storedEvents = await store.getEvents(sid);
    assert.equal(storedEvents.length, 0, "should have 0 events");

    const snapshot = buildResumeSnapshot(storedEvents);

    assert.ok(snapshot.includes('events_captured="0"'), "should have events_captured=0");
    assert.ok(snapshot.startsWith("<session_resume"), "should start with <session_resume");
    assert.ok(snapshot.endsWith("</session_resume>"), "should end with </session_resume>");

    // Even an empty snapshot can be upserted and consumed
    await store.upsertResume(sid, snapshot, 0);
    const resume = await store.getResume(sid);
    assert.ok(resume !== null, "empty resume should be stored");
    assert.equal(resume!.event_count, 0, "event_count should be 0");
  });
});
