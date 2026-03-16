/**
 * Session module loaders — bundle + ES-backed.
 *
 * Bundle loaders (loadExtract, loadSnapshot) load from esbuild bundles.
 * Session store is now ES-backed — loadSessionStore() returns the ES module.
 * loadSessionDB() is kept as a deprecated alias during transition.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function createSessionLoaders(hookDir) {
  const bundleDir = hookDir.endsWith("vscode-copilot")
    ? join(hookDir, "..")
    : hookDir;

  // Resolve the ES-backed session store from the build output
  const pkgRoot = join(bundleDir, "..");
  const esDbPath = join(pkgRoot, "build", "session", "es-db.js");

  return {
    /** Load the ES-backed SessionStore. */
    async loadSessionStore() {
      return await import(pathToFileURL(esDbPath).href);
    },
    /** @deprecated Use loadSessionStore() instead. */
    async loadSessionDB() {
      return await import(pathToFileURL(esDbPath).href);
    },
    async loadExtract() {
      return await import(pathToFileURL(join(bundleDir, "session-extract.bundle.mjs")).href);
    },
    async loadSnapshot() {
      return await import(pathToFileURL(join(bundleDir, "session-snapshot.bundle.mjs")).href);
    },
  };
}
