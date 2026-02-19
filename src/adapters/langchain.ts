import type { SpudAgent } from "../agent/wrapper.js";
import { SpudError } from "../types.js";

// ── LangChain compatible types (duck-typed) ─────────────────────────

/**
 * Minimal LangChain tool interface.
 *
 * Compatible with `StructuredTool`, `DynamicStructuredTool`, and any
 * object that satisfies this shape.
 */
export interface LangChainTool {
  name: string;
  description: string;
  invoke(input: unknown, config?: unknown): Promise<unknown>;
}

// ── Tool wrapping ─────────────────────────────────────────────────────

/**
 * Wrap a single LangChain tool with Spud governance.
 *
 * The returned tool preserves the original prototype chain (works with
 * `instanceof` checks in LangChain internals). Only `invoke` is
 * intercepted — governance is checked before each invocation.
 *
 * ```ts
 * import { wrapTool } from "@spud/sdk/langchain";
 *
 * const governed = wrapTool(agent, myTool);
 * const result = await governed.invoke({ query: "test" });
 * ```
 */
export function wrapTool<T extends LangChainTool>(
  agent: SpudAgent,
  tool: T,
): T {
  const wrapped = Object.create(
    Object.getPrototypeOf(tool) as object,
    Object.getOwnPropertyDescriptors(tool),
  ) as T;

  const originalInvoke = tool.invoke.bind(tool);

  wrapped.invoke = async (
    input: unknown,
    config?: unknown,
  ): Promise<unknown> => {
    const args =
      typeof input === "object" && input !== null
        ? (input as Record<string, unknown>)
        : { input };

    const { proceed, decision } = await agent.intercept({
      name: tool.name,
      arguments: args,
    });

    if (!proceed) {
      throw new SpudError(
        decision.reason ??
          `Tool "${tool.name}" denied by governance policy`,
        "TOOL_DENIED",
      );
    }

    return originalInvoke(input, config);
  };

  return wrapped;
}

/**
 * Wrap an array of LangChain tools with Spud governance.
 *
 * Convenience wrapper around `wrapTool` — pass the result to
 * `createToolCallingAgent`, `ToolNode`, or any LangChain construct
 * that accepts an array of tools.
 *
 * ```ts
 * import { wrapTools } from "@spud/sdk/langchain";
 *
 * const tools = wrapTools(agent, [searchTool, calculatorTool]);
 * const executor = new AgentExecutor({ agent, tools });
 * ```
 */
export function wrapTools<T extends LangChainTool>(
  agent: SpudAgent,
  tools: T[],
): T[] {
  return tools.map((tool) => wrapTool(agent, tool));
}
