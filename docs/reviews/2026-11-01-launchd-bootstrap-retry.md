# launchd EIO retry follow-up

A live authorized local upgrade returned `Bootstrap failed: 5: Input/output error` immediately after bootout; immediate rollback bootstrap also returned EIO. The plist was valid and enabled. A later manual bootstrap of the restored previous plist succeeded. The old service was restored before continuing. No credential values were printed or changed.

The installer now retries only bootstrap exit code 5, with five waits (100, 250, 500, 1000, 2000ms), at most six attempts. It never repeats bootout. Other exit codes and thrown errors retain the existing failure/recovery path. The same bound applies to restoring the previous service; exhausted upgrades still report failure even if rollback succeeds. Existing HOME-ownership and missing-previous-plist guards remain.

Two regression tests were RED before implementation: transient first-EIO then success; exhausted attempts followed by successful old-service recovery. Both are GREEN. Related installation tests: 68 passed. Independent read-only review found no new blocker.

Version 0.13.4 uses a fresh runtime directory rather than overwriting the unsuccessful 0.13.3 installation. Version metadata is synchronized in package.json, package-lock.json, src/index.ts and server.json. No public release/tag was created.

Final unmodified `npm test`: 423 tests, 421 passed, 0 failed, 2 environment skips (missing local Node 18; no packed release tree); smoke all checks passed. Live installation outcome is verified separately after this source is pushed. No new model call or account operation is used for that verification.
