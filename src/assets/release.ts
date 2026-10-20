/**
 * Delivery metadata for the self-contained runtime tarball.
 *
 * `ReleaseManifest` is **delivery metadata only**: it describes what
 * `scripts/pack-runtime.sh` produced so an installer can verify it, but nothing in
 * the runtime reads it to gate behaviour (the launcher resolves the fixed runtime
 * path and honours `SOUL37_NODE` without consulting it, and `status` never prints a
 * token from it). It is the single place the runtime's minimum Node and protocol
 * are declared.
 */
export const RELEASE_MANIFEST_PROTOCOL = "soul-assets/v1" as const;
export const RELEASE_MANIFEST_NODE_MIN = "18" as const;

export interface ReleaseManifest {
  /** The package version the tarball was built from. */
  version: string;
  protocol: typeof RELEASE_MANIFEST_PROTOCOL;
  /** Minimum supported Node major, as a string ("18"). */
  node_min: typeof RELEASE_MANIFEST_NODE_MIN;
  /** Relative paths inside the tarball root (e.g. "dist/bundle/cli.js"). */
  files: string[];
  /** SHA-256 of the actual tarball bytes (hex). */
  sha256: string;
}
