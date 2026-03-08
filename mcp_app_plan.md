# Stock MCP App — Implementation Plan (TypeScript/Node.js)

## Iterations
| Dir | Transport | Interface | Status |
|---|---|---|---|
| `1_stdio/` | stdio (subprocess) | CLI | planned |
| `2_http_cli/` | HTTP/SSE | CLI (2 containers) | planned |
| `3_vscode_notebook/` | HTTP/SSE | Test Script | planned |
| `4_express_html/` | HTTP/SSE | Express + vanilla HTML | planned |
| `5_express_react/` | HTTP/SSE | Express + React | planned |
| `6_code_mode/` | HTTP/SSE | Express + React + Cloudflare Code Mode | planned |

---

## Phase 1 — `1_stdio/`

### Context
Single Docker container. The CLI (MCP client) spawns the MCP server as a stdio
subprocess — the simplest MCP transport. Claude (via Anthropic SDK) acts as the
reasoning layer, calling MCP tools based on user questions. Responses are cached
in a flat JSON file to avoid redundant yahoo-finance-api calls.

Tickers: AAPL, AMZN, GOOGL, META, MSFT, NFLX, NVDA, TSLA

### Architecture

```
CLI (client/cli.ts)  <-->  Claude (claude-sonnet-4-6)
        | stdio subprocess
MCP Server (server/server.ts)
        |
yahoo-finance-api  +  JSON file cache (/data/cache.json)
```

### File Structure

```
1_stdio/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── server/
│   ├── server.ts          # @modelcontextprotocol/sdk — 4 tools
│   ├── cache.ts           # JSON file read/write with per-type TTL
│   └── package.json       # mcp, yahoo-finance-api
└── client/
    ├── cli.ts             # interactive loop: input -> Claude -> MCP -> output
    └── package.json       # @anthropic-ai/sdk, mcp
```

### MCP Server Tools

| Tool | Returns | Cache TTL |
|---|---|---|
| `get_current_price(ticker)` | price, change, change_pct, volume, market_cap | 15 min |
| `get_stock_overview(ticker)` | name, sector, P/E, 52w range, beta, description | 1 hour |
| `get_price_history(ticker, period)` | list of {date,open,high,low,close,volume}; period: 5d/1mo/3mo/1y | 24 hours |
| `get_financials(ticker)` | annual revenue, net_income, gross_profit + trailing EPS | 7 days |

### Running

```bash
# Docker (recommended)
cd 1_stdio
cp .env.example .env   # add ANTHROPIC_API_KEY
docker compose up --build
docker compose run --rm app

# Local (no Docker)
npm install
ANTHROPIC_API_KEY=sk-... npm run start:cli
```

---

## Phase 2 — `2_http_cli/`

### Context
Switch MCP transport from stdio to HTTP/SSE. Server and client now run as
**separate Docker containers** on a shared Docker network. The CLI is unchanged
from the user's perspective — the only difference is that the MCP client connects
over HTTP instead of spawning a subprocess. JSON file cache stays inside the server
container via a named volume.

Key learning: decoupling the MCP server from the client process, enabling the
server to be a long-running service rather than a short-lived subprocess.

### Architecture

```
[client container]                    [server container]
CLI (client/cli.ts)                   MCP Server (server/server.ts)
  + Claude (claude-sonnet-4-6)  <-->  SSE Client — Express on :8001
  + MCP SSE client                          |
                                      yahoo-finance-api  +  JSON file cache (/data/cache.json)
```

Docker network: `stock_net`
Server exposed at: `http://mcp-server:8001/sse`

### File Structure

```
2_http_cli/
├── docker-compose.yml
├── .env.example
├── server/
│   ├── Dockerfile
│   ├── server.ts          # @modelcontextprotocol/sdk — same 4 tools, HTTP/SSE transport
│   ├── cache.ts           # unchanged from Phase 1
│   └── package.json       # mcp, yahoo-finance-api
└── client/
    ├── Dockerfile
    ├── cli.ts             # same agentic loop; SSE client instead of stdio
    └── package.json       # @anthropic-ai/sdk, mcp
```

### What Changes vs Phase 1

| Concern | Phase 1 | Phase 2 |
|---|---|---|
| MCP transport | stdio subprocess | HTTP/SSE over Docker network |
| Containers | 1 | 2 (client + server) |
| Server lifetime | per CLI session | long-running service |
| Client transport init | `StdioServerParameters` | `sse_client(url)` |
| Server startup | `createStdioServer()` default (stdio) | Express SSE server |
| Cache volume | shared container fs (JSON file) | named volume on server container |

### MCP Server Tools
Identical to Phase 1 — no tool changes, only transport changes.

| Tool | Returns | Cache TTL |
|---|---|---|
| `get_current_price(ticker)` | price, change, change_pct, volume, market_cap | 15 min |
| `get_stock_overview(ticker)` | name, sector, P/E, 52w range, beta, description | 1 hour |
| `get_price_history(ticker, period)` | list of {date,open,high,low,close,volume}; period: 5d/1mo/3mo/1y | 24 hours |
| `get_financials(ticker)` | annual revenue, net_income, gross_profit + trailing EPS | 7 days |

### Key Implementation Notes

**server/server.ts** — configure host/port on the constructor, run with SSE transport:
```typescript
const server = new StdioServer({
  name: "Stock Analyst",
  version: "1.0.0",
});

// Add SSE transport handler
const app = express();
app.use(express.json());
app.get("/sse", (req, res) => {
  // SSE connection handling
});

app.listen(PORT, HOST);
```

**client/cli.ts** — swap stdio for SSE client:
```typescript
const { stdin, stdout } = await fetch(
  new URL("/sse", MCP_SERVER_URL)
).then(res => ({
  stdin: Readable.from(res.body),
  stdout: res.body,
}));

const client = new Client(...);
// ... same agentic loop as Phase 1
```

**docker-compose.yml** — two services, one network:
```yaml
services:
  mcp-server:
    build: ./server
    ports:
      - "8001:8001"
    volumes:
      - stock_cache:/data
    environment:
      - CACHE_FILE_PATH=/data/cache.json

  mcp-client:
    build: ./client
    depends_on:
      - mcp-server
    stdin_open: true
    tty: true
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - MCP_SERVER_URL=http://mcp-server:8001/sse

networks:
  default:
    name: stock_net

volumes:
  stock_cache:
```

### Running

```bash
cd 2_http_cli
cp .env.example .env   # add ANTHROPIC_API_KEY
docker compose up --build -d mcp-server   # start server first
docker compose run --rm mcp-client        # attach interactive CLI
```

---

## Phase 3 — `3_vscode_notebook/` (planned)

### Context

Each phase is self-contained. This phase bundles its own copy of the MCP server
so it can be run without any dependency on other phase directories. The notebook
client (VS Code notebook or simple interactive script) connects to the local server
over HTTP/SSE — but instead of an interactive CLI loop, it demonstrates:
concepts in isolation: raw tool invocation, single-turn Claude queries, and
multi-turn conversation.

Key learning: MCP tools can be called directly without Claude. Claude is just
one consumer of the MCP protocol — interactive testing makes it easy to inspect
tool schemas, test raw calls, and trace the agentic loop step by step.

### Architecture

```
Interactive Script (localhost)  -->  MCP Server (port 8001/SSE)
  MCP Client session              @modelcontextprotocol/sdk + yahoo-finance-api + JSON file cache
  Anthropic SDK (optional)
```

The MCP server runs in Docker; the test script runs locally and connects to it.

### File Structure

```
3_vscode_notebook/
├── docker-compose.yml     # spins up the MCP server
├── .env.example
├── server/                # copied from 2_http_cli/server/ — no changes
│   ├── Dockerfile
│   ├── server.ts
│   ├── cache.ts
│   └── package.json
├── test.ts               # 4 scenarios: setup, list tools, raw query, agentic loop
└── package.json          # @modelcontextprotocol/sdk, @anthropic-ai/sdk
```

### Test Script Scenarios

| Scenario | What it demonstrates |
|---|---|
| 1 | Setup & imports: SSE client & session initialization |
| 2 | Connect & list tools: `session.listTools()` — raw MCP tool schemas |
| 3 | Raw tool call (no Claude): `session.callTool()` — MCP without AI |
| 4 | Single-turn Claude query: Resolve one round of tool calls |
| 5 | Multi-turn agentic loop: Full interactive conversation |

### Key Implementation Notes

**test.ts — connect and list tools:**
```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL(MCP_SERVER_URL));
const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
for (const tool of tools.tools) {
  console.log(`${tool.name}: ${tool.description}`);
}
```

**test.ts — raw tool call (Claude not involved):**
```typescript
const result = await client.callTool("get_current_price", { ticker: "AAPL" });
console.log(JSON.stringify(result, null, 2));
```

**test.ts — single-turn query with tool resolution:**
```typescript
const response = await anthropic.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  system: SYSTEM_PROMPT,
  tools: anthropicTools,
  messages: [{ role: "user", content: "What is NVDA's current price?" }],
});
// resolve tool_use blocks -> call client.callTool() -> send result back
```

### What Changes vs Phase 2

| Concern | Phase 2 | Phase 3 |
|---|---|---|
| Client runtime | Docker container | Local Node.js / ts-node |
| Interaction model | Interactive CLI loop | Test script with named scenarios |
| Claude dependency | Required | Optional (Scenario 3 skips it) |
| MCP connection scope | Full session | Per scenario (new client) |
| Self-contained | Yes | Yes — own server/ copy + docker-compose |

### Running

```bash
cd 3_vscode_notebook
cp .env.example .env              # add ANTHROPIC_API_KEY

# 1. Start the local MCP server
docker compose up -d mcp-server

# 2. Install test dependencies
npm install

# 3. Run test scenarios
MCP_SERVER_URL=http://localhost:8001/sse \
ANTHROPIC_API_KEY=sk-... \
npm run test
```

---

## Phase 4 — `4_express_html/` (planned)

### Context

Each phase is self-contained. This phase bundles its own copy of the MCP server
alongside an Express.js bridge and a single static `index.html` with vanilla
JavaScript. Two containers total.

Key learning: The Express bridge and SSE streaming to a browser are concepts
that exist independently of React. Validating the full backend with plain HTML
first shrinks the debugging surface area before adding a build toolchain.

### Architecture

```
[api container]                              [server container]
Browser (localhost:8000)                     MCP Server (port 8001/SSE)
  GET /         → index.html (static files)   @modelcontextprotocol/sdk + yahoo-finance-api + JSON file cache
  POST /chat    → SSE stream
                    ↕ SSE client + Anthropic SDK
```

Express serves both the static HTML and the API from the same container.
No separate web container — two services total, same as Phase 2.

### File Structure

```
4_express_html/
├── docker-compose.yml
├── .env.example
├── server/                    # copied from 2_http_cli/server/ — no changes
│   ├── Dockerfile
│   ├── server.ts
│   ├── cache.ts
│   └── package.json
└── api/                       # Express + static HTML (NEW)
    ├── Dockerfile
    ├── main.ts                # lifespan MCP conn, POST /chat SSE, static file serving
    ├── static/
    │   └── index.html         # vanilla JS chat UI, ~120 lines
    └── package.json           # express, @anthropic-ai/sdk, mcp
```

### Express Bridge (`api/main.ts`)

Same lifespan + agentic loop pattern as Phase 5, but simpler — no CORS config
needed because HTML is served from the same origin. Static files are served
from the `/static` directory, and `GET /` returns `index.html` automatically.

```typescript
app.use(express.static("static"));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "static/index.html")));
```

The `/chat` route sits above the static mount and takes priority:

```typescript
app.post("/chat", async (req: Request, res: Response) => {
  const { message, session_id } = req.body;
  const conversation = sessions.get(session_id) || [];
  conversation.push({ role: "user", content: message });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  for await (const event of agenticLoop(conversation, mcp_session, mcp_tools)) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
});
```

**SSE event types** (identical across Phases 4 and 5):

| Event type | Payload | When |
|---|---|---|
| `tool_call` | `{name, args}` | before each MCP tool call |
| `text` | `{text}` | full assistant reply |
| `done` | `{}` | agentic loop complete |
| `error` | `{message}` | any exception |

### Vanilla JS Frontend (`api/static/index.html`)

Single self-contained file, no dependencies, no build step.

Key patterns:
- `sessionId` generated with `crypto.randomUUID()`, stored in `sessionStorage`
- `fetch` + `ReadableStream` to consume the SSE stream (same API React will use)
- Tool calls rendered as inline `<span class="tool-badge">` chips
- Input `disabled` while streaming; re-enabled on `done` event

```javascript
async function sendMessage(text) {
  const res = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text, session_id: sessionId }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();                       // keep incomplete chunk
    for (const part of parts) {
      if (!part.startsWith("data: ")) continue;
      handleEvent(JSON.parse(part.slice(6)));
    }
  }
}
```

### What Changes vs Phase 3 (Test Script)

| Concern | Phase 3 | Phase 4 |
|---|---|---|
| Client type | Node.js test script | Browser (vanilla JS) |
| Express bridge | None | Introduced |
| SSE to browser | No | Yes — `fetch` + `ReadableStream` |
| Session management | Per scenario | `sessionStorage` UUID |
| Containers | 1 (server only) | 2 (server + api) |
| Claude required | Optional | Always |

### Running

```bash
cd 4_express_html
cp .env.example .env   # add ANTHROPIC_API_KEY
docker compose up --build
# → Chat UI at http://localhost:8000
# → MCP server at http://localhost:8001
```

---

## Phase 5 — `5_express_react/` (planned)

Each phase is self-contained. This phase bundles its own copies of the MCP
server and the Express bridge. The bridge logic (`main.ts`, SSE events, session
management) is carried over from Phase 4 with one change: static file serving is
dropped and CORS is added, since the frontend now runs in a separate `web/`
container.

### Architecture

```
[web container]          [api container]               [server container]
React (port 5173)  -->  Express bridge (port 8000)  -->  MCP Server (port 8001/SSE)
  fetch + SSE             SSE client + Anthropic SDK      @modelcontextprotocol/sdk + yahoo-finance-api + JSON file cache
```

Three Docker containers on `stock_net`.
React proxies `/api/*` → Express via Vite config (no CORS issues in dev).

### File Structure

```
5_express_react/
├── docker-compose.yml
├── .env.example
├── server/                    # copied from 2_http_cli/server/ — no changes
│   ├── Dockerfile
│   ├── server.ts
│   ├── cache.ts
│   └── package.json
├── api/                       # Express bridge (NEW)
│   ├── Dockerfile
│   ├── main.ts                # lifespan MCP conn, /chat SSE, /health, /tools
│   └── package.json           # express, @anthropic-ai/sdk, mcp
└── web/                       # React frontend (NEW)
    ├── Dockerfile
    ├── package.json
    ├── vite.config.ts         # proxy /api -> http://api:8000
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── api.ts             # fetch-based SSE helper
        └── components/
            ├── ChatWindow.tsx
            ├── MessageBubble.tsx
            ├── ToolCallBadge.tsx
            └── ChatInput.tsx
```

### Express Bridge (`api/main.ts`)

**MCP lifecycle** — keep one long-lived connection via Express middleware:
```typescript
const transport = new SSEClientTransport(new URL(MCP_SERVER_URL));
const client = new Client({ name: "api", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

app.locals.mcpClient = client;
app.locals.mcpTools = await convertToolsToAnthropic(await client.listTools());
```

**Session management** — in-memory Map keyed by `session_id` (UUID from client):
```typescript
const sessions = new Map<string, Array<{ role: string; content: string }>>(); // session_id -> conversation history
```

**POST /chat** — streams SSE events back to React:
```typescript
app.post("/chat", async (req: Request, res: Response) => {
  const { message, session_id } = req.body;
  const conversation = sessions.get(session_id) || [];
  conversation.push({ role: "user", content: message });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  for await (const event of agenticLoop(conversation, app.locals.mcpClient, app.locals.mcpTools)) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
});
```

**SSE event types** emitted by `agenticLoop()`:

| Event type | Payload | When |
|---|---|---|
| `tool_call` | `{name, args}` | before each MCP tool call |
| `text_chunk` | `{text}` | streaming Claude text (if using streaming API) |
| `text` | `{text}` | full assistant reply (non-streaming) |
| `done` | `{}` | agentic loop finished |
| `error` | `{message}` | any exception |

**Other endpoints:**
- `GET /health` → `{"status": "ok"}`
- `GET /tools` → list of MCP tool names + descriptions

### React Frontend

**Component tree:**
```
App (session_id UUID, useState for messages)
└── ChatWindow
    ├── MessageList
    │   └── MessageBubble (role: user | assistant)
    │       └── ToolCallBadge[]  (shown inline for assistant messages)
    └── ChatInput (textarea + send button, disabled while streaming)
```

**`api.ts` — SSE via fetch ReadableStream:**
```typescript
export async function sendMessage(
  message: string,
  sessionId: string,
  onEvent: (e: SSEEvent) => void
) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, session_id: sessionId }),
  });
  const reader = res.body!.getReader();
  // decode stream, split on "\n\n", parse JSON from "data: ..." lines
}
```

**Vite proxy** (avoids CORS, works identically in dev and Docker):
```typescript
// vite.config.ts
server: { proxy: { "/api": { target: "http://api:8000", rewrite: p => p.replace(/^\/api/, "") } } }
```

### Docker Compose

```yaml
services:
  mcp-server:   # identical to Phase 2
    build: ./server
    ports: ["8001:8001"]
    volumes: [stock_cache:/data]
    environment: [CACHE_FILE_PATH=/data/cache.json, HOST=0.0.0.0, PORT=8001]
    healthcheck: ...

  api:
    build: ./api
    ports: ["8000:8000"]
    depends_on:
      mcp-server: { condition: service_healthy }
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - MCP_SERVER_URL=http://mcp-server:8001/sse

  web:
    build: ./web
    ports: ["5173:5173"]
    depends_on: [api]

networks:
  default:
    name: stock_net

volumes:
  stock_cache:
```

### What Changes vs Phase 4 (Vanilla HTML)

| Concern | Phase 4 | Phase 5 |
|---|---|---|
| Frontend | Single `index.html`, no build | React + Vite + TypeScript |
| API serving | Express static files | Separate `web/` container |
| Containers | 2 (server + api) | 3 (server + api + web) |
| SSE consumer | Vanilla JS `fetch` loop | Same pattern, typed in `api.ts` |
| Routing / proxy | None needed (same origin) | Vite `server.proxy` → `/api` |
| `api/main.ts` | Unchanged except drop static files | Identical logic, CORS added |

### Running

```bash
cd 5_express_react
cp .env.example .env   # add ANTHROPIC_API_KEY
docker compose up --build
# → React at http://localhost:5173
# → Express at http://localhost:8000
# → MCP server at http://localhost:8001
```

---

## Phase 6 — `6_code_mode/` (planned)

Each phase is self-contained. This phase carries over the Phase 5 React + Express
stack but replaces the traditional `tool_use` agentic loop with **Cloudflare's
Code Mode** pattern: instead of asking Claude to call tools via structured
`tool_use` blocks, the bridge asks Claude to write TypeScript that calls the tools
directly. The generated code is executed in a sandboxed Node.js `vm` isolate inside
the Express container.

Key learning: LLMs have seen far more TypeScript in their training data than
`tool_use` JSON syntax. Code mode lets Claude express multi-step logic (conditionals,
loops, parallel calls) in a single generation pass — only the final results flow
back through the model, cutting token overhead for chained tool calls.
Reference: [Cloudflare Blog — Code Mode](https://blog.cloudflare.com/code-mode/)

### Architecture

```
[web container]          [api container]                          [server container]
React (port 5173)  -->  Express bridge (port 8000)            -->  MCP Server (port 8001/SSE)
  fetch + SSE             1. fetch MCP tool schemas                 @modelcontextprotocol/sdk
                          2. generate TS type defs                  + yahoo-finance-api + SQLite
                          3. Claude writes code (no tool_use)
                          4. execute in vm.Script sandbox
                          5. stream result back as SSE
```

Three Docker containers on `stock_net` — same count as Phase 5.

### File Structure

```
6_code_mode/
├── docker-compose.yml
├── .env.example
├── server/                    # copied from 2_http_cli/server/ — no changes
│   ├── Dockerfile
│   ├── server.ts
│   ├── cache.ts
│   └── package.json
├── api/
│   ├── Dockerfile
│   ├── main.ts                # lifespan MCP conn, /chat SSE, /health, /tools
│   ├── codegen.ts             # MCP schema → TS type defs + system prompt
│   ├── sandbox.ts             # vm.Script executor with MCP bindings
│   └── package.json           # express, @anthropic-ai/sdk, mcp
└── web/                       # React frontend — unchanged from Phase 5
    ├── Dockerfile
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── api.ts
        └── components/
            ├── ChatWindow.tsx
            ├── MessageBubble.tsx
            ├── ToolCallBadge.tsx
            └── ChatInput.tsx
```

### MCP Schema → TypeScript (`api/codegen.ts`)

On startup, fetch the MCP tool list and generate TypeScript function signatures
that Claude will see in its system prompt:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";

export function mcpToolsToTypeScript(tools: Tool[]): string {
  return tools.map(t => {
    const params = Object.entries(t.inputSchema.properties ?? {})
      .map(([k, v]: [string, any]) => `${k}: ${v.type}`)
      .join(", ");
    return `/** ${t.description} */\nasync function ${t.name}(${params}): Promise<any>;`;
  }).join("\n\n");
}

export function buildSystemPrompt(toolDefs: string): string {
  return `You are a stock analyst. Answer the user's question by writing a
single async TypeScript function called \`run()\` that uses the tools below.
Return ONLY the code block — no explanation.

Available tools (already bound in scope):
\`\`\`typescript
${toolDefs}
\`\`\`

Example:
\`\`\`typescript
async function run() {
  const price = await get_current_price("AAPL");
  const overview = await get_stock_overview("AAPL");
  return \`\${overview.name} trades at $\${price.price} (P/E \${overview.pe_ratio})\`;
}
\`\`\``;
}
```

### Sandboxed Execution (`api/sandbox.ts`)

The generated code runs in a `vm.Script` context. MCP tool functions are injected
as bindings — the sandbox has no access to the network or filesystem directly:

```typescript
import vm from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

export async function runInSandbox(
  code: string,
  mcpClient: Client,
  toolNames: string[]
): Promise<string> {
  // Build MCP bindings: { get_current_price: async (ticker) => mcpClient.callTool(...) }
  const bindings: Record<string, Function> = {};
  for (const name of toolNames) {
    bindings[name] = async (args: Record<string, unknown>) =>
      mcpClient.callTool(name, args).then(r =>
        r.content[0].type === "text" ? JSON.parse(r.content[0].text) : r.content[0]
      );
  }

  const context = vm.createContext({ ...bindings, result: undefined });
  const wrapped = `(async () => { ${code}\n result = await run(); })()`;
  await vm.Script.prototype.runInContext.call(new vm.Script(wrapped), context);
  return String(context.result);
}
```

### Agentic Loop (`api/main.ts`)

Code mode collapses the multi-turn tool-call loop into a single Claude call:

```typescript
async function* agenticLoop(
  conversation: MessageParam[],
  mcpClient: Client,
  toolDefs: string,
  toolNames: string[]
) {
  // Single Claude call — no tool_use, just text (the generated code)
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: buildSystemPrompt(toolDefs),
    messages: conversation,
    // No `tools:` array — Claude writes code instead
  });

  const rawCode = extractCodeBlock(response.content[0].text);
  yield { type: "code", code: rawCode };   // optional: show generated code in UI

  const output = await runInSandbox(rawCode, mcpClient, toolNames);

  conversation.push({ role: "assistant", content: output });
  yield { type: "text", text: output };
  yield { type: "done" };
}
```

**SSE event types** — one new event type vs Phase 5:

| Event type | Payload | When |
|---|---|---|
| `code` | `{code}` | Claude's generated TypeScript (before execution) |
| `text` | `{text}` | sandbox execution result |
| `done` | `{}` | complete |
| `error` | `{message}` | any exception |

### React Frontend

Identical to Phase 5 except `ChatWindow` optionally renders `code` events as a
collapsible `<pre>` block so the user can inspect the generated TypeScript.

### What Changes vs Phase 5 (React + tool_use)

| Concern | Phase 5 | Phase 6 |
|---|---|---|
| Agentic loop | Multi-turn `tool_use` / `tool_result` | Single-turn code generation |
| Tool invocation | Anthropic structured blocks | Claude-written TypeScript |
| Execution | Express calls `mcpClient.callTool()` directly | `vm.Script` sandbox with MCP bindings |
| Token overhead | Each tool result re-enters the model | Only final `run()` return value |
| Multi-step logic | LLM decides step-by-step | LLM writes the full plan as code |
| `tools:` in API call | Required | Omitted — system prompt provides TS sigs |
| Containers | 3 | 3 (unchanged) |
| React frontend | Unchanged | +optional code block display |

### Running

```bash
cd 6_code_mode
cp .env.example .env   # add ANTHROPIC_API_KEY
docker compose up --build
# → React at http://localhost:5173
# → Express at http://localhost:8000
# → MCP server at http://localhost:8001
```
