import { SpudClient } from "../core/client.js";
import type { ReportRequest, ReportResponse } from "../types.js";

/**
 * Execution confirmation — closes the audit loop.
 *
 * After a governed tool executes on the server side, call this to report
 * the outcome back to the Spud platform via POST /v1/confirm.
 *
 * ```ts
 * const server = await SpudServer.init({ apiKey: "..." });
 *
 * // ... tool executes ...
 *
 * await server.report({
 *   event_id: req.spud.event_id,
 *   result: "success",
 *   metadata: { rows_affected: 42 },
 * });
 * ```
 */
export async function report(
  client: SpudClient,
  req: ReportRequest,
): Promise<ReportResponse> {
  return client.request<ReportResponse>("POST", "/v1/confirm", {
    event_id: req.event_id,
    result: req.result,
    metadata: req.metadata ?? {},
  });
}
