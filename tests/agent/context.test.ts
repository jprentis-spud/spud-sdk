import { describe, it, expect } from "vitest";
import { AgentContext } from "../../src/agent/context.js";

describe("AgentContext", () => {
  // ── Enrichment hooks ───────────────────────────────────────────────

  describe("buildContext()", () => {
    it("returns empty object when no hooks registered", async () => {
      const ctx = new AgentContext({});
      const result = await ctx.buildContext({
        name: "send_email",
        arguments: {},
      });
      expect(result).toEqual({});
    });

    it("runs a single hook and returns its context", async () => {
      const ctx = new AgentContext({});
      ctx.addHook(async () => ({ user_id: "u-123", org_id: "org-456" }));

      const result = await ctx.buildContext({
        name: "send_email",
        arguments: { to: "a@b.com" },
      });
      expect(result).toEqual({ user_id: "u-123", org_id: "org-456" });
    });

    it("merges multiple hooks — later hooks overwrite on collision", async () => {
      const ctx = new AgentContext({});
      ctx.addHook(async () => ({ user_id: "u-1", role: "viewer" }));
      ctx.addHook(async () => ({ role: "admin", team: "platform" }));

      const result = await ctx.buildContext({
        name: "delete_record",
        arguments: {},
      });
      expect(result).toEqual({
        user_id: "u-1",
        role: "admin", // overwritten by second hook
        team: "platform",
      });
    });

    it("passes the tool call to each hook", async () => {
      const ctx = new AgentContext({});
      ctx.addHook(async (tc) => ({ tool: tc.name, arg_count: Object.keys(tc.arguments).length }));

      const result = await ctx.buildContext({
        name: "query_db",
        arguments: { sql: "SELECT 1", limit: 10 },
      });
      expect(result).toEqual({ tool: "query_db", arg_count: 2 });
    });

    it("runs hooks concurrently", async () => {
      const ctx = new AgentContext({});
      const order: number[] = [];

      ctx.addHook(async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
        return { a: 1 };
      });
      ctx.addHook(async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(2);
        return { b: 2 };
      });

      const result = await ctx.buildContext({ name: "test", arguments: {} });
      expect(result).toEqual({ a: 1, b: 2 });
      // Hook 2 should finish before hook 1 since they run concurrently
      expect(order).toEqual([2, 1]);
    });
  });

  // ── Governance mode ────────────────────────────────────────────────

  describe("mode", () => {
    it("defaults to enforcing", () => {
      const ctx = new AgentContext({});
      expect(ctx.mode).toBe("enforcing");
    });

    it("accepts permissive", () => {
      const ctx = new AgentContext({ mode: "permissive" });
      expect(ctx.mode).toBe("permissive");
    });

    it("accepts dry-run", () => {
      const ctx = new AgentContext({ mode: "dry-run" });
      expect(ctx.mode).toBe("dry-run");
    });
  });

  // ── Failure mode resolution ────────────────────────────────────────

  describe("failureModeFor()", () => {
    it("defaults to closed when no policy configured", () => {
      const ctx = new AgentContext({});
      expect(ctx.failureModeFor("send_email")).toBe("closed");
    });

    it("returns open for exact-match failOpen tools", () => {
      const ctx = new AgentContext({
        failurePolicy: { failOpen: ["get_user", "list_items"] },
      });
      expect(ctx.failureModeFor("get_user")).toBe("open");
      expect(ctx.failureModeFor("list_items")).toBe("open");
      expect(ctx.failureModeFor("delete_user")).toBe("closed");
    });

    it("returns closed for exact-match failClosed tools", () => {
      const ctx = new AgentContext({
        failurePolicy: {
          failClosed: ["delete_user"],
          default: "open",
        },
      });
      expect(ctx.failureModeFor("delete_user")).toBe("closed");
      expect(ctx.failureModeFor("get_user")).toBe("open"); // default
    });

    it("supports trailing wildcard patterns", () => {
      const ctx = new AgentContext({
        failurePolicy: {
          failOpen: ["get_*", "list_*"],
          failClosed: ["delete_*", "drop_*"],
        },
      });
      expect(ctx.failureModeFor("get_user")).toBe("open");
      expect(ctx.failureModeFor("get_orders")).toBe("open");
      expect(ctx.failureModeFor("list_items")).toBe("open");
      expect(ctx.failureModeFor("delete_user")).toBe("closed");
      expect(ctx.failureModeFor("drop_table")).toBe("closed");
      expect(ctx.failureModeFor("update_user")).toBe("closed"); // default
    });

    it("respects custom default", () => {
      const ctx = new AgentContext({
        failurePolicy: { default: "open" },
      });
      expect(ctx.failureModeFor("anything")).toBe("open");
    });

    it("failOpen takes priority when tool matches both lists", () => {
      const ctx = new AgentContext({
        failurePolicy: {
          failOpen: ["send_*"],
          failClosed: ["send_*"],
        },
      });
      // failOpen is checked first
      expect(ctx.failureModeFor("send_email")).toBe("open");
    });
  });
});
