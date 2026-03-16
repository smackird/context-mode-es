/**
 * Shared test helpers for ES-backed store tests.
 *
 * Creates ephemeral indexes (ctx-test-*) per test and cleans them up after.
 * All tests hit the live ES 9.3 cluster configured in secrets/.elastic.env.
 */

import { randomUUID } from "node:crypto";
import { loadElasticConfig, getClient, deleteIndex } from "../../src/es-base.js";
import { SessionStore } from "../../src/session/es-db.js";
import { ContentStoreES } from "../../src/store-es.js";

// Load ES config once at module import time
loadElasticConfig();

/**
 * Create an ephemeral SessionStore backed by a unique test index.
 * Caller must call cleanupIndex(indexName) in afterEach/afterAll.
 */
export async function createTestSessionStore(): Promise<{
  store: SessionStore;
  indexName: string;
}> {
  const indexName = `ctx-test-sessions-${randomUUID().slice(0, 8)}`;
  const client = getClient();
  const store = await SessionStore.create(client, indexName);
  return { store, indexName };
}

/**
 * Create an ephemeral ContentStoreES backed by a unique test index.
 * Caller must call cleanupIndex(indexName) in afterEach/afterAll.
 */
export async function createTestContentStore(): Promise<{
  store: ContentStoreES;
  indexName: string;
}> {
  const indexName = `ctx-test-content-${randomUUID().slice(0, 8)}`;
  const client = getClient();
  const store = await ContentStoreES.create(client, indexName);
  return { store, indexName };
}

/**
 * Delete a test index. Silently ignores if it doesn't exist.
 */
export async function cleanupIndex(indexName: string): Promise<void> {
  await deleteIndex(indexName);
}

/**
 * Force an index refresh so that recently indexed documents are searchable.
 * Required after writes when the next operation is a search assertion.
 */
export async function refreshIndex(indexName: string): Promise<void> {
  const client = getClient();
  await client.indices.refresh({ index: indexName });
}
