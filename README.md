# @spud/sdk

Belt and Braces governance for AI agents. One SDK, three integration modes — wrap your agent's tool calls, validate tokens on your tool server, or proxy traffic for closed platforms.

## Install

```bash
npm install @spud/sdk
```

## Quickstart

```ts
import { Spud } from "@spud/sdk";

const spud  = await Spud.init({ apiKey: process.env.SPUD_API_KEY! });
const agent = spud.agent({ mode: "enforcing" });

const { proceed } = await agent.intercept({ name: "send_email", arguments: { to: "cfo@acme.com" } });
```

Three lines: init, create an agent, check governance. Every tool call your agent makes can be governed before it executes.

## Integration Modes

Spud provides three ways to add governance depending on where you can insert code.

### Belt — Agent Wrapper

Use when you **own the agent code**. The SDK wraps outbound tool calls with governance checks before they execute.

```ts
import { Spud } from "@spud/sdk";

const spud  = await Spud.init({ apiKey: process.env.SPUD_API_KEY! });
const agent = spud.agent({ mode: "enforcing" });

// Add business context to every governance decision
agent.enrichContext(async (toolCall) => ({
  user_id: session.userId,
  org_id:  session.orgId,
}));

// Check governance before executing a tool
const { proceed, decision } = await agent.intercept({
  name: "delete_record",
  arguments: { table: "users", id: 42 },
});

if (proceed) {
  await executeTool("delete_record", { table: "users", id: 42 });
}
```

### Braces — Server Validator

Use when you **own the tool server**. Validates the Spud JWT attached by the agent (or proxy) so your server can verify governance was applied, then closes the audit loop by reporting the execution outcome.

```ts
import { SpudServer } from "@spud/sdk";
import express from "express";

const server = await SpudServer.init({ apiKey: process.env.SPUD_API_KEY! });
const app = express();

// Validates X-Spud-Token header, sets req.spud with decoded claims
app.use(server.middleware());

app.post("/tools/execute", async (req, res) => {
  // req.spud has: tenant_id, profile, permissions, scope, event_id
  const result = await executeTool(req.body);

  // Close the audit loop
  await server.report({
    event_id: req.spud.event_id,
    result: "success",
    metadata: { tool: req.body.name },
  });

  res.json(result);
});
```

### Proxy — For Closed Platforms

Use when you **don't control the agent or the tool server** — platforms like Salesforce Agentforce, ElevenLabs, or any system where you can only configure a tool URL.

Point the platform at `proxy.spud.rocks` instead of the direct tool URL. Spud sits in the middle, applies governance to every `tools/call` request, attaches the JWT, and forwards permitted calls to the real upstream.

```
Agent (Agentforce, ElevenLabs, etc.)
  │
  ▼
proxy.spud.rocks          ← governance applied here
  │
  ▼
Your MCP server / tool API
```

For self-hosted proxy scenarios, the SDK provides an MCP HTTP proxy you can run yourself:

```ts
const spud  = await Spud.init({ apiKey: process.env.SPUD_API_KEY! });
const agent = spud.agent({ mode: "enforcing" });
const proxy = agent.proxy({ upstream: "http://your-mcp-server:3000" });

// proxy.handler is (Request) => Promise<Response>
// Use with any Web-API-compatible server (Node 18+, Bun, Deno, Workers)
Bun.serve({ fetch: proxy.handler, port: 8080 });
```

## Framework Adapters

### Vercel AI SDK

Two options: middleware (intercepts at the model output level) or tool wrapping (intercepts at execution time).

**Option A — Middleware** (intercepts `generateText` and `streamText` tool calls):

```ts
import { Spud } from "@spud/sdk";
import { spudMiddleware } from "@spud/sdk/vercel-ai";
import { wrapLanguageModel, generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const spud  = await Spud.init({ apiKey: process.env.SPUD_API_KEY! });
const agent = spud.agent({ mode: "enforcing" });

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: spudMiddleware(agent),
});

// Denied tool calls are silently removed from the model response
const result = await generateText({ model, tools, prompt: "..." });
```

**Option B — Tool wrapping** (wraps each tool's `execute` directly):

```ts
import { Spud } from "@spud/sdk";
import { wrapTools } from "@spud/sdk/vercel-ai";
import { generateText, tool } from "ai";
import { z } from "zod";

const spud  = await Spud.init({ apiKey: process.env.SPUD_API_KEY! });
const agent = spud.agent({ mode: "enforcing" });

const tools = wrapTools(agent, {
  weather: tool({
    description: "Get current weather",
    parameters: z.object({ location: z.string() }),
    execute: async ({ location }) => fetchWeather(location),
  }),
  sendEmail: tool({
    description: "Send an email",
    parameters: z.object({ to: z.string(), body: z.string() }),
    execute: async ({ to, body }) => sendEmail(to, body),
  }),
});

// Denied tools throw SpudError with code "TOOL_DENIED"
const result = await generateText({ model, tools, prompt: "..." });
```

### LangChain.js

Wrap individual tools or an entire array. Preserves the prototype chain so `instanceof` checks still work.

```ts
import { Spud } from "@spud/sdk";
import { wrapTools } from "@spud/sdk/langchain";
import { ChatOpenAI } from "@langchain/openai";
import { createToolCallingAgent, AgentExecutor } from "langchain/agents";

const spud  = await Spud.init({ apiKey: process.env.SPUD_API_KEY! });
const agent = spud.agent({ mode: "enforcing" });

const tools = wrapTools(agent, [searchTool, calculatorTool, emailTool]);

const llm = new ChatOpenAI({ model: "gpt-4o" });
const lcAgent = await createToolCallingAgent({ llm, tools, prompt });
const executor = new AgentExecutor({ agent: lcAgent, tools });

// Each tool.invoke() checks governance before executing
const result = await executor.invoke({ input: "..." });
```

## Governance Modes

Control how the SDK reacts to governance decisions.

| Mode | Denied tool call | Governance unreachable | Use case |
|------|-----------------|----------------------|----------|
| `"enforcing"` | **Blocked** | Applies failure policy | Production — full governance |
| `"permissive"` | Allowed (logged) | Allowed (logged) | Rollout — observe before enforcing |
| `"dry-run"` | Allowed (not logged) | Allowed | Development — test policies without impact |

```ts
const agent = spud.agent({ mode: "enforcing" });
```

## Failure Modes

When the governance service is unreachable, the failure policy determines whether each tool is allowed or denied. Tool name patterns support trailing wildcards.

| Policy | Behaviour when governance is down | Example |
|--------|----------------------------------|---------|
| `failOpen` | Tool is **allowed** | Read-only tools: `"get_*"`, `"list_*"` |
| `failClosed` | Tool is **denied** | Destructive tools: `"delete_*"`, `"send_*"` |
| `default` | Applies when a tool matches neither list | `"closed"` (default) or `"open"` |

```ts
const agent = spud.agent({
  mode: "enforcing",
  failurePolicy: {
    failOpen:   ["get_*", "list_*", "search_*"],
    failClosed: ["delete_*", "send_*", "execute_*"],
    default:    "closed",
  },
});
```

## Enrichment Hooks

Add business context to every governance request. Hooks run concurrently and their results are merged (later hooks overwrite on key collision).

```ts
agent.enrichContext(async (toolCall) => ({
  user_id: session.userId,
  org_id:  session.orgId,
  role:    session.role,
}));

agent.enrichContext(async (toolCall) => ({
  ip_address: request.ip,
  user_agent: request.headers["user-agent"],
}));
```

## Scripts

```bash
pnpm build        # Compile TypeScript to dist/
pnpm test         # Run all tests
pnpm lint         # Lint src/ and tests/
pnpm typecheck    # Type-check without emitting
```

## License

MIT
