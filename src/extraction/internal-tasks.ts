/**
 * Task 4: the internal-job registry and the single recursion guard.
 *
 * Extraction runs inside a live runtime whose own hooks fire for the model's
 * messages / subtasks / Stop. Every event those internal calls emit carries the
 * job uid in `RuntimeEvent.internal_job_uid`; `isInternalEvent` is the one
 * predicate that excludes them, so an internal emission can never schedule
 * another extraction job (and therefore can never recurse into the model).
 *
 * The marking is structural — a uid on the event plus the frozen
 * `ExtractionRequest.internal_task: true` plus the `NativeInvoker` `internal_job_uid`
 * argument — never a prompt instruction. The registry tracks live jobs in this
 * process so `runExtraction` can recover their frozen request by uid.
 */
import type { BindingSnapshot, ExtractionRequest, RuntimeEvent, SourceRange } from "../adapters/types.js";

export interface InternalJob {
  jobUid: string;
  root: string;
  profileId: string;
  binding: BindingSnapshot;
  range: SourceRange;
  request: ExtractionRequest;
}

const activeJobs = new Map<string, InternalJob>();

export function registerInternalJob(job: InternalJob): void {
  activeJobs.set(job.jobUid, job);
}

export function unregisterInternalJob(jobUid: string): void {
  activeJobs.delete(jobUid);
}

export function getInternalJob(jobUid: string): InternalJob | undefined {
  return activeJobs.get(jobUid);
}

export function listInternalJobUids(): string[] {
  return [...activeJobs.keys()];
}

/** The only recursion guard: an event carrying a job uid is an internal emission. */
export function isInternalEvent(event: RuntimeEvent): boolean {
  return typeof event.internal_job_uid === "string" && event.internal_job_uid !== "";
}
