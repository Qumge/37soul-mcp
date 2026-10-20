/**
 * MCP-facing error/text helpers for the stdio server, extracted so the 410
 * assets-only fail-closed mapping can be unit-tested without booting the
 * transport (index.ts connects StdioServerTransport on import).
 *
 * `statusError` maps an HTTP response to the explicit MCP tool result the model
 * should see. It is pure over `(response, context, baseUrl)`: a 410 from the
 * server is surfaced verbatim as an explicit error and never downgraded,
 * retried or reported as success — the "fail closed" half of the assets-only
 * upgrade contract lives here, and the caller must not wrap it in retry logic.
 */

export interface McpTextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function text(t: string, isError = false): McpTextResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

/** "The update may have been applied" disambiguation for the two post tools that
 *  cannot prove delivery — never used for 410, which is a hard refusal. */
export function unknownPostResult(ctx: string, prefix: string): McpTextResult {
  if (ctx === "chat_with_host") {
    return text(`${prefix} The message may still have been delivered. Do not send it again; use read_chat_history to check.`, true);
  }
  if (ctx === "instruct_post") {
    return text(`${prefix} The post may still have been published. Do not instruct it again; use read_recent_posts to check.`, true);
  }
  return text(`${prefix} The update may still have been applied. Read the host again before trying it another time.`, true);
}

/** Map a non-2xx HTTP response to an explicit MCP tool result (or null when ok). */
export function statusError(res: Response, ctx: string, baseUrl: string): McpTextResult | null {
  if (res.ok) return null;
  switch (res.status) {
    case 401: return text(`Unauthorized — check your SOUL37_API_TOKEN (regenerate at ${baseUrl}/agent_access).`, true);
    case 402: return text("Out of messages — the daily free allowance for this character is used up and the account has no credits left. Top up or subscribe on 37soul.com, or try again tomorrow.", true);
    case 403: return text("That host is unlisted, so 37Soul no longer generates content for it. Re-list it on 37soul.com to post again. (Chatting with it still works.)", true);
    case 404: return text(ctx === "get_operation"
      ? "That operation does not exist or does not belong to this account."
      : "That host isn't yours (or doesn't exist). Use list_hosts to see your host ids.", true);
    case 409: return text("That idempotency key was already used for a different request. Start a new deliberate action instead of retrying this one.", true);
    case 410: return text(
      "This account is in assets-only mode (410 assets_only_mode). Raw transcripts, facts, checkpoints and identity edits no longer flow through the legacy write tools — the local soul sync is the write path. Change her identity on 37soul.com.",
      true,
    );
    case 422: return text(`Invalid parameters for ${ctx}.`, true);
    case 429: return text(ctx === "instruct_post"
      ? "Post not accepted — this host is already processing another post instruction or has reached 8 posts/hour. Wait before trying again."
      : "Rate limited by 37Soul. Wait before trying again.", true);
    case 502:
      if (ctx === "instruct_post") {
        return unknownPostResult(ctx, "37Soul could not confirm the post operation.");
      }
      if (ctx === "chat_with_host") {
        return unknownPostResult(ctx, "37Soul could not complete the chat response.");
      }
      return text(`37Soul is temporarily unavailable for ${ctx}. It is safe to retry this read operation.`, true);
    default:
      if (ctx === "chat_with_host" || ctx === "instruct_post") {
        return unknownPostResult(ctx, `37Soul returned an unexpected error while running ${ctx}.`);
      }
      return text(`37Soul is unavailable right now (${ctx}). Try again shortly.`, true);
  }
}
