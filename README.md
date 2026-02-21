<p align="center">
  <img src="https://raw.githubusercontent.com/jprentis-spud/spud-sdk/main/assets/spud-logo.svg" alt="Spud" width="200" />
</p>

<h1 align="center">@spud-dev/sdk</h1>

<p align="center">
  Belt and Braces governance SDK for AI agents.
</p>

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://www.npmjs.com/package/@spud-dev/sdk"><img src="https://img.shields.io/npm/v/@spud-dev/sdk.svg" alt="npm version" /></a>
</p>

---

Policy enforcement, trust scoring, and immutable audit trails for every tool call your AI agent makes.

## Install

```bash
npm install @spud-dev/sdk
```

## Quick Start

```ts
import { Spud } from "@spud-dev/sdk";

// 1. Initialise
const spud = await Spud.init({ apiKey: process.env.SPUD_API_KEY! });

// 2. Wrap your agent
const agent = spud.agent({ mode: "enforcing" });

// 3. Govern tool calls
const { proceed, decision } = await agent.intercept({
  name: "send_email",
  arguments: { to: "cfo@acme.com" },
});

if (proceed) {
  await sendEmail("cfo@acme.com");
}
```

Three lines: init, wrap, govern. Every tool call your agent makes can be checked before it executes.

## Governance Modes

Control how the SDK reacts to governance decisions:

| Mode | Denied tool call | Governance unreachable | Use case |
|------|-----------------|----------------------|----------|
| `"enforcing"` | **Blocked** | Applies failure policy | Production |
| `"permissive"` | Allowed (logged) | Allowed (logged) | Rollout — observe before enforcing |
| `"dry-run"` | Allowed (not logged) | Allowed | Development — test policies |

```ts
const agent = spud.agent({ mode: "enforcing" });
```

### Failure Policy

When governance is unreachable, control per-tool behaviour with trailing wildcard patterns:

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

### Enrichment Hooks

Add business context to every governance request. Hooks run concurrently and results are merged:

```ts
agent.enrichContext(async (toolCall) => ({
  user_id: session.userId,
  org_id:  session.orgId,
  role:    session.role,
}));
```

## Server SDK

The "Braces" side — validate governance tokens on your tool server and close the audit loop.

```ts
import { SpudServer } from "@spud-dev/sdk";
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
  });

  res.json(result);
});
```

### Validate (Web API)

For non-Express frameworks (Hono, Bun, Deno, Cloudflare Workers):

```ts
const claims = await server.validate(request); // reads X-Spud-Token header
```

### Validate Token (raw)

```ts
const claims = await server.validateToken(jwtString);
```

## Framework Adapters

### Vercel AI SDK

**Middleware** — intercepts tool calls at the model output level:

```ts
import { Spud } from "@spud-dev/sdk";
import { spudMiddleware } from "@spud-dev/sdk/vercel-ai";
import { wrapLanguageModel, generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const spud  = await Spud.init({ apiKey: process.env.SPUD_API_KEY! });
const agent = spud.agent({ mode: "enforcing" });

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: spudMiddleware(agent),
});

const result = await generateText({ model, tools, prompt: "..." });
```

**Tool wrapping** — intercepts at execution time:

```ts
import { wrapTools } from "@spud-dev/sdk/vercel-ai";

const governed = wrapTools(agent, {
  weather: tool({ ... }),
  sendEmail: tool({ ... }),
});

const result = await generateText({ model, tools: governed, prompt: "..." });
```

### LangChain

Wrap individual tools or arrays. Preserves prototype chains for `instanceof` checks:

```ts
import { wrapTools } from "@spud-dev/sdk/langchain";

const tools = wrapTools(agent, [searchTool, calculatorTool, emailTool]);

const executor = new AgentExecutor({ agent: lcAgent, tools });
const result = await executor.invoke({ input: "..." });
```

## MCP Proxy

For closed platforms (Salesforce Agentforce, ElevenLabs, etc.) where you can only configure a tool URL:

```ts
const proxy = agent.proxy({ upstream: "http://your-mcp-server:3000" });

// proxy.handler is (Request) => Promise<Response>
Bun.serve({ fetch: proxy.handler, port: 8080 });
```

## Documentation

Full documentation is available at [spud-site.vercel.app/docs](https://spud-site.vercel.app/docs).

## Development

```bash
pnpm install       # Install dependencies
pnpm build         # Build with tsup (ESM + CJS + DTS)
pnpm test          # Run all tests
pnpm lint          # Lint src/ and tests/
pnpm typecheck     # Type-check without emitting
```

## License

MIT
