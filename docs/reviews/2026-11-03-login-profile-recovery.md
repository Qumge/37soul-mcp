# Runtime 0.14.2: login recovery without resetting old data

## Reproduction and behavior

An installed machine can retain a cloud-owned profile with an unknown issuer, no active-profile selection and duplicate account-index associations. The previous plain `37soul login` stopped at an abstract `--profile` placeholder. It must not guess ownership or merge that data into a website account.

- Interactive `37soul login` explains that old data stays separate, asks the human to confirm, then creates a uniquely named reconnection profile. Normal website device-code authorization and Soul selection/pull follow. Old profile snapshots stay byte-for-byte unchanged; no old memories or consent are copied.
- Noninteractive login prints a concrete independent-profile command and stops without creating it. Agent instructions require human confirmation before using it.
- Refusing, Ctrl-C and EOF do not authenticate, create a profile or change existing metadata. Explicit profile selection keeps issuer checks. Damaged/unsupported shared metadata is rejected before login can normalize and overwrite it.
- Upgrade installation inspects existing selection before contacting an old writer. It never reinitializes ambiguous existing data; the new CLI/hooks/service are installed and login recovery is clearly requested. Malformed configuration stops installation before any mutation.
- Doctor marks unavailable local profile as fatal instead of claiming local readiness. Installation may therefore finish writing the runtime but return nonzero until the user runs the next, separate login command. Retained inactive anonymous data does not make a successfully restored website connection appear unauthenticated.
- No host trust bypass, source-data upload, raw conversation sync or automatic local-data merge was introduced.

## Verification

- Initial focused recovery TDD: 17 tests, 3 failures before implementation; all 17 passed afterward. Normal login, explicit selection, corrupt syntax/structure and diagnostic regressions were then added.
- Final login/install boundary tests: 41 passed. Installer added old-writer and malformed-config RED→GREEN coverage.
- Real pseudo-terminal decline, Ctrl-C and EOF: 3 PASS, synthetic HOME only; all old file bytes unchanged and normal cancellation exit. No production login was performed.
- Final packed-artifact `SOUL37_REQUIRE_PACKED_RELEASE=1 npm test`: 641 tests, 640 pass, 0 fail, 1 skip (no local Node18 binary); smoke: all checks passed. Node18/20/24 coverage remains a separate CI verification stage.
- Tarball version: 0.14.2. SHA256: d02ad6c7bb23bdbad1983f26837bf8b771c8bc63cbfaa7d366e2e2dc74883785.
- Three-language README and agent guide updated. The website guide is synchronized independently; website business pages and the user's actual profile/configuration were not modified by these tests.

Publication, public download and optional real-user authorization are distinct from the above local results; report them separately in the delivery.
