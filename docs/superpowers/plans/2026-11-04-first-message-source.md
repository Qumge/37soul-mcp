# First-message native source recovery

User reported a fresh Claude session fails connect twice, then succeeds after sending another message. Exact session metadata shows UserPromptSubmit additional context timestamp01:02:26.017Z, while the transcript is created01:02:26.090Z (73ms later). No source pointer/binding existed after the first turn; the second request produced its own hook pointer and attached successfully. No credentials/identity problem. Existing unrelated screenshot of invalid Bash allow rule is not changed.

## Design
Keep only the native hook's reported absolute path/session metadata when stat returnsENOENT on resume/request. This lives in a separate0700/0600 bounded session-source-hints store (max128 perprofile,7dayexpiry), never in source-event pointers or extraction ranges. Connect still opens and validates the real file and freezes its currentEOF. No cwd/recency/sessionguess, fabricatedfile, inferredpath, rawconversation, newbinding or modelcall while the file is absent. Newer prospectivepath prevents falling back to an older transcript. The helperprojects exactknown metadata fields ratherthan copying arbitrary event-key properties.

## Files
- src/agentd/session-source-hints.ts: atomic, scoped pending metadata.
- src/agentd/source-index.ts: newest exact native source may come from this pendingmetadata, then existing filevalidation.
- src/extraction/scheduler.ts: record only native resume/request hints; completed-turn source/extraction gates stay unchanged.
- test/local-agent-connect.test.mjs: first-filecreation, noother-sessionfallback, newerpath, andnoextra-event-key-rawdata regressions.

## Verification
Baseline local-agent-connect+source-index40/40. Newfirstmessage3tests:2RED/1pass; fieldprojectionregression1RED. Focusedsource/connect/boundary49/49 before fieldtest; final counts recorded in delivery. A temporarynativeClaudeCLI harness withlocalhostAPIstub provesbaseline0.15.4firstsource_exists=false/connectexit1 vsfixedfirstsource_exists=false/connectattached in same turn; no externalmodel/account calls.

Reviewfocus: malformed/stale/duplicate prospective metadata; device/profile/native isolation; source replacement atconnect andcompletedturn; latewriterbudget; pendinghints cannotbe read as extraction sources. No site/businessflow changes. User's continuing releaseauthorization applies to the verified corrective release; preserve original WIPandcredentials.
