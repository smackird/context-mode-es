/**
 * es-index-naming — Shared index naming utilities for the ES migration.
 *
 * Extracts the SHA256 project hash computation and index name construction
 * that was previously duplicated across all 6 adapters and session-helpers.
 *
 * Index naming convention: ctx-{type}-{platformId}-{hash16}
 * Satisfies ES constraints: lowercase, no special chars, < 255 bytes.
 *
 * Reference: plans/merged/file_and_function_mapping/merged_src_adapters_types_v1.md
 */

import { createHash } from "node:crypto";

/**
 * Compute the first 16 hex characters of the SHA-256 hash of a project directory.
 * This is the same derivation used by the original SQLite-based `getSessionDBPath()`.
 */
export function computeProjectHash(projectDir: string): string {
  return createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
}

/**
 * Build the ES session index name for a given platform and project.
 * Format: ctx-sessions-{platformId}-{projectHash}
 */
export function buildSessionIndexName(
  platformId: string,
  projectHash: string,
): string {
  return `ctx-sessions-${platformId}-${projectHash}`;
}

/**
 * Build the ES content index name for a given project.
 * Format: ctx-content-{projectHash}
 *
 * Content indices are not platform-scoped because the knowledge base
 * is shared across platforms for a given project directory.
 */
export function buildContentIndexName(projectHash: string): string {
  return `ctx-content-${projectHash}`;
}
