/**
 * The extraction turn is framed as one JSON object, not as labeled text lines.
 *
 * A line-oriented rendering cannot preserve provenance: a newline inside a
 * tool_result (or an assistant message) starts a new line, so a literal
 * "User: ..." in tool output looks like a human statement to the model. Here
 * every content item is a message with an explicit `source`; the text is data.
 * JSON escaping also closes quote/newline/U+2028-style framing tricks.
 */
export const SOURCE_TURN_FORMAT = "37soul-source-turn/v1";

export type TurnMessageSource = "user" | "assistant" | "tool";
export type TurnMessageKind = "text" | "tool_call" | "tool_result";

export interface TurnMessage {
  source: TurnMessageSource;
  kind: TurnMessageKind;
  /** Resolved tool name for tool_call/tool_result messages. */
  name?: string;
  text: string;
}

export function serializeSourceTurn(messages: readonly TurnMessage[]): string {
  // No matching content items is not an empty turn to send to the model — the
  // adapters treat "" as source_unavailable, exactly like the pre-JSON renderer.
  if (messages.length === 0) return "";
  return JSON.stringify({ format: SOURCE_TURN_FORMAT, messages })
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/\u0085/g, "\\u0085");
}
