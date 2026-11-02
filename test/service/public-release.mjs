#!/usr/bin/env node
// Fetch release evidence only; never installs or invokes models.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireHostedRunner } from './acceptance.mjs';
export const PUBLIC_RELEASE_BASE = 'https://github.com/Qumge/37soul-mcp/releases/latest/download';
export const PUBLIC_INSTALLER_URL = 'https://37soul.com/install.sh';
const assets = ['37soul-runtime.tgz', '37soul-runtime.tgz.sha256', 'release-manifest.json', 'VERSION'];
export function validateReleaseMetadata(files, expectedVersion) {
  const version = files.VERSION.toString().trim();
  assert.equal(version, expectedVersion, 'public latest must match expected candidate version');
  const sha256 = createHash('sha256').update(files['37soul-runtime.tgz']).digest('hex');
  const recorded = files['37soul-runtime.tgz.sha256'].toString().trim().split(/\s+/)[0];
  assert.equal(recorded, sha256, 'public archive checksum mismatch');
  const manifest = JSON.parse(files['release-manifest.json']);
  assert.equal(manifest.version, version, 'public manifest version mismatch');
  assert.equal(manifest.sha256, sha256, 'public manifest checksum mismatch');
  assert.equal(manifest.protocol, 'soul-assets/v1');
  return { version, sha256 };
}
async function main() {
  requireHostedRunner(process.env);
  const [directory, packageFile] = process.argv.slice(2);
  assert.ok(directory && packageFile, 'usage: public-release.mjs RELEASE_DIR EXPECTED_PACKAGE_JSON');
  const expectedVersion = JSON.parse(await readFile(packageFile, 'utf8')).version;
  const files = {}, sources = {};
  for (const asset of assets) {
    const url = `${PUBLIC_RELEASE_BASE}/${asset}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    assert.ok(response.ok, `download ${asset}: HTTP ${response.status}`);
    files[asset] = Buffer.from(await response.arrayBuffer());
    sources[asset] = { url, resolvedUrl: response.url };
  }
  const metadata = validateReleaseMetadata(files, expectedVersion);
  await mkdir(directory, { recursive: true });
  for (const asset of assets) await writeFile(path.join(directory, asset), files[asset]);
  const packedPackage = JSON.parse(execFileSync('tar', ['-xOzf', path.join(directory, '37soul-runtime.tgz'), '37soul/package.json'], { encoding: 'utf8', timeout: 15_000 }));
  assert.equal(packedPackage.version, metadata.version, 'public packed package version mismatch');
  const provenance = { mode: 'public_release', installerUrl: PUBLIC_INSTALLER_URL, releaseBase: PUBLIC_RELEASE_BASE, ...metadata, sources };
  await writeFile(path.join(directory, 'public-release.json'), JSON.stringify(provenance, null, 2));
  console.log(JSON.stringify(provenance));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
