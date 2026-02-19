import type {
  AgentConfig,
  EnrichmentHook,
  FailurePolicy,
  GovernanceMode,
  ToolCall,
} from "../types.js";

/**
 * Entity context management for governance decisions.
 *
 * Holds enrichment hooks that add business context (user id, org,
 * permissions, etc.) to every governance request, plus the governance
 * mode and failure policy configuration.
 */
export class AgentContext {
  readonly mode: GovernanceMode;
  private readonly hooks: EnrichmentHook[] = [];
  private readonly failurePolicy: Required<FailurePolicy>;

  constructor(config: AgentConfig) {
    this.mode = config.mode ?? "enforcing";
    const fp = config.failurePolicy ?? {};
    this.failurePolicy = {
      failOpen: fp.failOpen ?? [],
      failClosed: fp.failClosed ?? [],
      default: fp.default ?? "closed",
    };
  }

  // ── Enrichment hooks ─────────────────────────────────────────────

  /**
   * Register an async function that adds business context to every
   * governance request.
   *
   * ```ts
   * agent.enrichContext(async (toolCall) => ({
   *   user_id: session.userId,
   *   org_id: session.orgId,
   * }));
   * ```
   */
  addHook(hook: EnrichmentHook): void {
    this.hooks.push(hook);
  }

  /**
   * Run all enrichment hooks and merge results into a single context
   * object. Later hooks overwrite earlier ones on key collision.
   */
  async buildContext(toolCall: ToolCall): Promise<Record<string, unknown>> {
    const results = await Promise.all(
      this.hooks.map((hook) => hook(toolCall)),
    );
    return Object.assign({}, ...results) as Record<string, unknown>;
  }

  // ── Failure mode resolution ──────────────────────────────────────

  /**
   * Determine whether a tool should fail open or closed when the
   * governance service is unreachable.
   */
  failureModeFor(toolName: string): "open" | "closed" {
    if (matchesAny(this.failurePolicy.failOpen, toolName)) return "open";
    if (matchesAny(this.failurePolicy.failClosed, toolName)) return "closed";
    return this.failurePolicy.default;
  }
}

// ── Pattern matching (trailing wildcard only) ──────────────────────

function matchesAny(patterns: string[], name: string): boolean {
  return patterns.some((p) => matchPattern(p, name));
}

function matchPattern(pattern: string, name: string): boolean {
  if (pattern.endsWith("*")) {
    return name.startsWith(pattern.slice(0, -1));
  }
  return pattern === name;
}
