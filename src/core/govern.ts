import { SpudClient } from "./client.js";
import { GovernRequest, GovernResponse } from "../types.js";

/**
 * Explicit governance check — the "manual escape hatch" in the Belt and
 * Braces model.
 *
 * Call this when agent code wants to ask the Spud platform whether a
 * specific action is permitted before executing it.
 *
 * ```ts
 * const decision = await spud.govern({
 *   action: "send_email",
 *   context: { to: "user@example.com", subject: "Hello" },
 * });
 * if (!decision.permitted) {
 *   console.log("Blocked:", decision.reason);
 * }
 * ```
 */
export async function govern(
  client: SpudClient,
  req: GovernRequest,
): Promise<GovernResponse> {
  return client.request<GovernResponse>("POST", "/v1/govern", {
    action: req.action,
    context: req.context ?? {},
    blocking: req.blocking ?? true,
  });
}
