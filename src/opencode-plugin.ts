/**
 * OpenCode TypeScript plugin entry point for context-mode.
 *
 * Provides three hooks:
 *   - tool.execute.before  — Routing enforcement (deny/modify/passthrough)
 *   - tool.execute.after   — Session event capture
 *   - experimental.session.compacting — Compaction snapshot generation
 *
 * Loaded by OpenCode via: import("context-mode/plugin").ContextModePlugin(ctx)
 *
 * Constraints:
 *   - No SessionStart hook (OpenCode doesn't support it — #14808, #5409)
 *   - No context injection (canInjectSessionContext: false)
 *   - Session cleanup happens at plugin init (no SessionStart)
 */

import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SessionStore } from "./session/es-db.js";
import { loadElasticConfig, getClient } from "./es-base.js";
import { computeProjectHash } from "./adapters/es-index-naming.js";
import { extractEvents } from "./session/extract.js";
import type { HookInput } from "./session/extract.js";
import { buildResumeSnapshot } from "./session/snapshot.js";
import type { SessionEvent } from "./types.js";
import { OpenCodeAdapter } from "./adapters/opencode/index.js";

// ── Types ─────────────────────────────────────────────────

/** OpenCode plugin context passed to the factory function. */
interface PluginContext {
  directory: string;
}

/** Shape of the input object OpenCode passes to hook functions. */
interface ToolHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  is_error?: boolean;
  sessionID?: string;
}

// ── Plugin Factory ────────────────────────────────────────

/**
 * OpenCode plugin factory. Called once when OpenCode loads the plugin.
 * Returns an object mapping hook event names to async handler functions.
 */
export const ContextModePlugin = async (ctx: PluginContext) => {
  // Resolve build dir from compiled JS location
  const buildDir = dirname(fileURLToPath(import.meta.url));

  // Load routing module (ESM .mjs, lives outside build/ in hooks/)
  const routingPath = resolve(buildDir, "..", "hooks", "core", "routing.mjs");
  const routing = await import(pathToFileURL(routingPath).href);
  await routing.initSecurity(buildDir);

  // Initialize ES-backed session store
  const projectDir = ctx.directory;
  loadElasticConfig();
  const client = getClient();
  const hash = computeProjectHash(projectDir);
  const indexName = `ctx-sessions-opencode-${hash}`;
  const store = await SessionStore.create(client, indexName);
  const sessionId = randomUUID();
  await store.ensureSession(sessionId, projectDir);

  // Auto-write AGENTS.md on startup for OpenCode projects
  try {
    new OpenCodeAdapter().writeRoutingInstructions(projectDir, resolve(buildDir, ".."));
  } catch {
    // best effort — never break plugin init
  }

  // Clean up old sessions on startup (replaces SessionStart hook)
  await store.cleanupOldSessions(0);

  return {
    // ── PreToolUse: Routing enforcement ─────────────────

    "tool.execute.before": async (input: ToolHookInput) => {
      const toolName = input.tool_name ?? "";
      const toolInput = input.tool_input ?? {};

      let decision;
      try {
        decision = routing.routePreToolUse(toolName, toolInput, projectDir);
      } catch {
        return; // Routing failure → allow passthrough
      }

      if (!decision) return; // No routing match → passthrough

      if (decision.action === "deny" || decision.action === "ask") {
        // Throw to block — OpenCode catches this and denies the tool call
        throw new Error(decision.reason ?? "Blocked by context-mode");
      }

      if (decision.action === "modify" && decision.updatedInput) {
        // Mutate args in place — OpenCode reads the mutated input
        Object.assign(toolInput, decision.updatedInput);
      }

      // "context" action → no-op (OpenCode doesn't support context injection)
    },

    // ── PostToolUse: Session event capture ──────────────

    "tool.execute.after": async (input: ToolHookInput) => {
      try {
        const hookInput: HookInput = {
          tool_name: input.tool_name ?? "",
          tool_input: input.tool_input ?? {},
          tool_response: input.tool_output,
          tool_output: input.is_error ? { isError: true } : undefined,
        };

        const events = extractEvents(hookInput);
        for (const event of events) {
          await store.insertEvent(sessionId, event as SessionEvent, "PostToolUse");
        }
      } catch {
        // Silent — session capture must never break the tool call
      }
    },

    // ── PreCompact: Snapshot generation ─────────────────

    "experimental.session.compacting": async () => {
      try {
        const events = await store.getEvents(sessionId);
        if (events.length === 0) return "";

        const stats = await store.getSessionStats(sessionId);
        const snapshot = buildResumeSnapshot(events, {
          compactCount: (stats?.compact_count ?? 0) + 1,
        });

        await store.upsertResume(sessionId, snapshot, events.length);
        await store.incrementCompactCount(sessionId);

        return snapshot;
      } catch {
        return "";
      }
    },
  };
};
