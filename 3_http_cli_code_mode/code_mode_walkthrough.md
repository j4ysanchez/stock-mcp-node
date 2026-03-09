# Code Mode Walkthrough — `3_http_cli_code_mode/`

## What is this app?

A **stock research chatbot** you talk to in the terminal. You ask it a question like *"What's Apple's P/E ratio?"*, and it fetches real live data from Yahoo Finance and answers you.

It's built in two pieces — a **server** and a **client** — that talk to each other using a protocol called **MCP (Model Context Protocol)**.

---

## The Big Picture

```
You (terminal)
    │  type a question
    ▼
┌─────────────────────────────────┐
│  CLIENT  (cli.ts)               │
│  • Talks to Gemini AI           │
│  • Asks Gemini to write code    │
│  • Runs that code in a sandbox  │
└────────────┬────────────────────┘
             │  MCP over HTTP/SSE
             ▼
┌─────────────────────────────────┐
│  SERVER  (server.ts)            │
│  • Wraps Yahoo Finance API      │
│  • Exposes 4 "tools"            │
│  • Caches results to disk       │
└─────────────────────────────────┘
             │  live data
             ▼
       Yahoo Finance
```

---

## File-by-file Walkthrough

### `docker-compose.yml` — The launcher

This runs both pieces together in Docker. Key things to notice:

- `mcp-server` starts first; the client **waits** until the server passes a health check (`/health` endpoint)
- The server is reachable at `http://mcp-server:8001/sse` (only inside Docker networking)
- Your `GEMINI_API_KEY` is passed in as an environment variable

---

### `server/server.ts` — The MCP Server

This is an **Express HTTP server** that exposes 4 stock data tools over the MCP protocol. Think of MCP tools like API endpoints that an AI can discover and call.

The 4 tools it registers:

| Tool name | What it fetches |
|---|---|
| `get_current_price` | Real-time price, volume, market cap |
| `get_stock_overview` | Sector, P/E ratio, 52-week range, beta |
| `get_price_history` | Daily OHLCV data for 5d/1mo/3mo/1y |
| `get_financials` | Revenue, net income, EPS |

Each tool is registered with a **Zod schema** — this validates inputs and also auto-generates a JSON Schema that MCP clients can read to know what parameters the tool accepts.

The server exposes two HTTP endpoints for MCP:
- `GET /sse` — client connects here to establish a session
- `POST /messages` — client sends tool-call requests here

---

### `client/cli.ts` — The main CLI loop

This is the entry point. On startup:

1. Connects to the MCP server via SSE
2. Calls `listTools()` to discover what tools exist
3. Converts those tools into TypeScript function signatures (via `codegen.ts`)
4. Builds a system prompt telling Gemini "here are the functions you can call"
5. Starts a Gemini chat session

Then for each question you type, `agentTurn()` runs:

```
Your question
    │
    ▼  Step 1: ask Gemini
Gemini writes a TypeScript run() function (streamed to your terminal)
    │
    ▼  Step 2: execute it
sandbox.ts runs the code, which calls MCP tools
    │
    ▼  Step 3: format it
Feed the raw JSON data back to Gemini, ask it to write a nice answer
    │
    ▼
Printed to your terminal
```

---

### `client/codegen.ts` — The prompt builder

Two functions:

**`mcpToolsToTypeScript()`** — converts MCP tool schemas into fake TypeScript function signatures like:
```typescript
/** Get real-time price... */
async function get_current_price(/** Stock ticker symbol */ ticker: string): Promise<any>;
```

**`buildSystemPrompt()`** — wraps those signatures into a system prompt that tells Gemini: *"You are a stock assistant. Answer by writing a `run()` function using these pre-bound functions. Return ONLY a code block."*

This is the "Code Mode" pattern — instead of using the AI's native function-calling API, you ask the AI to **write executable code**, then you run that code yourself.

---

### `client/sandbox.ts` — The code executor

This is where it gets interesting. After Gemini writes a `run()` function, you can't just `eval()` it — that would be dangerous. Instead, Node.js has a built-in `node:vm` module that runs code in an **isolated context**.

Here's what `runInSandbox()` does:

1. **Builds "bindings"** — for each MCP tool, creates a JavaScript function that calls `mcpClient.callTool()` under the hood
2. **Transpiles TypeScript → JavaScript** using `esbuild` (because `vm` can't run TypeScript directly)
3. **Creates a sandboxed context** with only those bindings available (no `require`, no `fs`, etc.)
4. **Wraps and runs** the code: `(async () => { <Gemini's code> \n __result = await run(); })()`
5. Returns `__result` (the JSON string Gemini's `run()` returned)

---

## The "Code Mode" concept (vs traditional function calling)

Traditional AI tool use ("Phase 2" in this project):
```
You → AI → "call get_price(AAPL)" → you call it → feed result back → AI answers
(multiple round-trips for complex queries)
```

Code Mode ("Phase 3" = this app):
```
You → AI → writes run() { await Promise.all([get_price(AAPL), get_overview(AAPL)]) }
         → you execute it → feed raw data back → AI formats answer
(one round-trip, can parallelize tool calls natively)
```

The AI writes the orchestration logic itself, including `Promise.all` for parallel calls.

---

## Running it

```bash
cp .env.example .env
# edit .env and add your GEMINI_API_KEY

docker compose up --build
```

Then type questions like:
- *"What's AAPL's current price?"*
- *"Compare MSFT and GOOGL P/E ratios"*
- *"Show me NVDA's 3-month price history"*
