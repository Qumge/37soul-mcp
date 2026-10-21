/**
 * Local runtime-adapter boundary types (§8 of the contract + the plan's 内部类型边界).
 *
 * Everything here stays local to the adapter layer: it never becomes an HTTP DTO
 * and must never carry raw transcript text, tool output, cwd, files or tokens.
 * Field names follow the wire snake_case for the native/runtime domain, matching
 * the frozen ExtractionRequest / RuntimeProbe shapes. The source body itself is
 * read by the adapter's own local reader, not passed through these types.
 */
import type { Binding, ContextBundle, ProposedAsset, RuntimeKind } from "../assets/protocol.js";

/** Local binding key: never sent to the cloud (native_session_id stays local). */
export interface NativeSessionKey {
  profile_id: string;
  device_id: string;
  runtime_kind: RuntimeKind;
  native_session_id: string;
}

/** A bounded range of source event refs within one native session. */
export interface SourceRange {
  event_refs: string[];
  start: number;
  end: number;
  /** Actual host turn record ids when the hook can identify them; never wire data. */
  turn_refs?: string[];
}

export type RuntimeEventKind =
  | "request"
  | "turn_completed"
  | "checkpoint"
  | "explicit_feedback"
  | "compact"
  | "resume"
  | "reset";

export interface RuntimeEvent {
  key: NativeSessionKey;
  event_ref: string;
  kind: RuntimeEventKind;
  /** Actual host turn record ids for this completed event, if the hook observed them. */
  source_turn_refs?: string[];
  /** Set for events emitted by an internal extraction job so the scheduler can exclude them. */
  internal_job_uid: string | null;
}

export interface ExtractionRequest {
  job_uid: string;
  runtime_kind: RuntimeKind;
  native_session_id: string;
  source_event_refs: string[];
  /** Actual host turn record ids selected for this job (optional, local only). */
  source_turn_refs?: string[];
  binding_uid: string;
  binding_revision: number;
  soul_uid: string;
  internal_task: true;
}

export type ExtractionResult =
  | { proposals: ProposedAsset[] }
  | { error: { code: string; retryable: boolean } };

export interface RuntimeProbe {
  runtime_kind: RuntimeKind;
  version: string;
  /** Native session identity is available. */
  session_id: boolean;
  /** A before-request lifecycle point exists for context injection. */
  before_request: boolean;
  /** The tool can produce a structured result from a bounded source turn. */
  structured_extraction: boolean;
  /** Internal model tasks can be tagged and excluded from recursive extraction. */
  internal_marker: boolean;
  resume: boolean;
  compact: boolean;
  interrupt: boolean;
}

export interface InjectionResult {
  delivered: boolean;
  rendered_sha256: string;
  error?: string;
}

export interface RuntimeAdapter {
  runtime_kind: RuntimeKind;
  probe(): Promise<RuntimeProbe>;
  extract(request: ExtractionRequest): Promise<ExtractionResult>;
  inject(bundle: ContextBundle): Promise<InjectionResult>;
}

export type NativeInvoker = (
  runtime: RuntimeKind,
  args: readonly string[],
  input: string,
  internal_job_uid: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface AdapterDeps {
  home: string;
  invoke: NativeInvoker;
  readSource: (refs: readonly string[]) => Promise<string>;
  emit: (event: RuntimeEvent) => Promise<void>;
}

export type Clock = () => number;
export type HttpFetch = typeof fetch;
export type ProfileId = string;

/** A Binding plus its local native session key. */
export type BindingSnapshot = Binding & NativeSessionKey;
