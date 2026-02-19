import type { SpudAgent } from "../agent/wrapper.js";
import { SpudError } from "../types.js";

// ── Vercel AI SDK compatible types (duck-typed) ─────────────────────
//
// Minimal interfaces matching the Vercel AI SDK so consumers get full
// type-safety without a hard dependency on the `ai` package.

/** A function tool call in a model response. */
export interface LanguageModelV1FunctionToolCall {
  toolCallType: "function";
  toolCallId: string;
  toolName: string;
  args: string; // JSON-encoded arguments
}

/** Result shape from a non-streaming model call. */
export interface GenerateResult {
  toolCalls?: LanguageModelV1FunctionToolCall[];
  [key: string]: unknown;
}

/** A single part emitted on a model stream. */
export interface StreamPart {
  type: string;
  toolCallType?: string;
  toolCallId?: string;
  toolName?: string;
  args?: string;
  argsTextDelta?: string;
  [key: string]: unknown;
}

/** Result shape from a streaming model call. */
export interface StreamResult {
  stream: ReadableStream<StreamPart>;
  [key: string]: unknown;
}

/**
 * Middleware compatible with the Vercel AI SDK's
 * `wrapLanguageModel({ model, middleware })`.
 */
export interface LanguageModelV1Middleware {
  wrapGenerate?: (options: {
    doGenerate: () => PromiseLike<GenerateResult>;
    params: unknown;
    model: unknown;
  }) => PromiseLike<GenerateResult>;
  wrapStream?: (options: {
    doStream: () => PromiseLike<StreamResult>;
    params: unknown;
    model: unknown;
  }) => PromiseLike<StreamResult>;
}

/** Minimal Vercel AI tool shape. */
export interface VercelAITool {
  description?: string;
  parameters: unknown;
  execute?: (
    args: Record<string, unknown>,
    options?: unknown,
  ) => PromiseLike<unknown> | unknown;
}

/** A map of tool name to tool definition, matching generateText({ tools }). */
export type VercelAITools = Record<string, VercelAITool>;

// ── Middleware ─────────────────────────────────────────────────────────

/**
 * Create a Vercel AI SDK middleware that governs tool calls.
 *
 * Use with `wrapLanguageModel` to intercept tool calls at the model
 * output level before the SDK executes them:
 *
 * ```ts
 * import { wrapLanguageModel } from "ai";
 * import { spudMiddleware } from "@spud/sdk/vercel-ai";
 *
 * const model = wrapLanguageModel({
 *   model: openai("gpt-4o"),
 *   middleware: spudMiddleware(agent),
 * });
 *
 * const result = await generateText({ model, tools, prompt });
 * ```
 *
 * In `generateText`, denied tool calls are removed from the model
 * response so the SDK never executes them.
 *
 * In `streamText`, tool-call stream parts are buffered per call and
 * only forwarded once the complete call passes governance.
 */
export function spudMiddleware(
  agent: SpudAgent,
): LanguageModelV1Middleware {
  return {
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();

      if (!result.toolCalls?.length) return result;

      const governed: LanguageModelV1FunctionToolCall[] = [];

      for (const tc of result.toolCalls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.args) as Record<string, unknown>;
        } catch {
          args = {};
        }

        const { proceed } = await agent.intercept({
          name: tc.toolName,
          arguments: args,
        });

        if (proceed) {
          governed.push(tc);
        }
      }

      return { ...result, toolCalls: governed };
    },

    async wrapStream({ doStream }) {
      const { stream, ...rest } = await doStream();

      const deniedCallIds = new Set<string>();
      const buffered = new Map<string, StreamPart[]>();

      const transform = new TransformStream<StreamPart, StreamPart>({
        async transform(chunk, controller) {
          // Buffer tool-call-delta parts until the final tool-call arrives
          if (chunk.type === "tool-call-delta" && chunk.toolCallId) {
            const id = chunk.toolCallId;
            if (!buffered.has(id)) buffered.set(id, []);
            buffered.get(id)!.push(chunk);
            return;
          }

          // Complete tool-call — run governance, then flush or drop
          if (
            chunk.type === "tool-call" &&
            chunk.toolCallId &&
            chunk.toolName
          ) {
            let args: Record<string, unknown>;
            try {
              args = JSON.parse(chunk.args ?? "{}") as Record<string, unknown>;
            } catch {
              args = {};
            }

            const { proceed } = await agent.intercept({
              name: chunk.toolName,
              arguments: args,
            });

            if (!proceed) {
              deniedCallIds.add(chunk.toolCallId);
              buffered.delete(chunk.toolCallId);
              return;
            }

            // Flush buffered deltas then the complete part
            for (const part of buffered.get(chunk.toolCallId) ?? []) {
              controller.enqueue(part);
            }
            buffered.delete(chunk.toolCallId);
            controller.enqueue(chunk);
            return;
          }

          // Everything else passes through
          controller.enqueue(chunk);
        },
      });

      return { ...rest, stream: stream.pipeThrough(transform) };
    },
  };
}

// ── Tool wrapping ─────────────────────────────────────────────────────

/**
 * Wrap Vercel AI SDK tools with Spud governance.
 *
 * Each tool's `execute` function is intercepted so that governance is
 * checked before the tool runs. Denied calls throw a `SpudError`.
 *
 * Works with both `generateText` and `streamText`:
 *
 * ```ts
 * import { wrapTools } from "@spud/sdk/vercel-ai";
 *
 * const governed = wrapTools(agent, {
 *   weather: tool({ ... }),
 *   sendEmail: tool({ ... }),
 * });
 *
 * const result = await generateText({ model, tools: governed, prompt });
 * ```
 */
export function wrapTools<T extends VercelAITools>(
  agent: SpudAgent,
  tools: T,
): T {
  const wrapped = {} as Record<string, VercelAITool>;

  for (const [name, tool] of Object.entries(tools)) {
    if (!tool.execute) {
      wrapped[name] = tool;
      continue;
    }

    const originalExecute = tool.execute;

    wrapped[name] = {
      ...tool,
      execute: async (
        args: Record<string, unknown>,
        options?: unknown,
      ) => {
        const { proceed, decision } = await agent.intercept({
          name,
          arguments: args,
        });

        if (!proceed) {
          throw new SpudError(
            decision.reason ??
              `Tool "${name}" denied by governance policy`,
            "TOOL_DENIED",
          );
        }

        return originalExecute(args, options);
      },
    };
  }

  return wrapped as T;
}
