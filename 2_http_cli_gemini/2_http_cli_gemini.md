# 2_http_cli_gemini Plan

## What This Is

A self-contained variant of Phase 2 (`2_http_cli`) that uses the **Google Gemini API** (`gemini-3.1-flash-lite-preview`) instead of Anthropic Claude. The only client-level change from `1b_stdio_gemini` is replacing the stdio subprocess transport with an **HTTP/SSE transport** — the server is now a long-running Docker container, not a child process.

```
You → CLI → Google GenAI SDK → Gemini (gemini-3.1-flash-lite-preview)
                → MCP SSE Client → [HTTP/SSE over Docker network] → MCP Server → Yahoo Finance
```

---

## Why This Phase

| Phase | Transport | Containers | LLM |
|---|---|---|---|
| `1b_stdio_gemini` | stdio subprocess | 1 | Gemini |
| `2_http_cli_gemini` | HTTP/SSE | 2 | Gemini |

Key learning: decoupling the MCP server from the client process. The server becomes a long-running service; multiple clients could connect to the same instance. The Gemini agentic loop is identical to `1b_stdio_gemini` — only the MCP transport changes.

---

## Architecture

```
[client container]                         [server container]
CLI (client/cli.ts)                        MCP Server (server/server.ts)
  + Gemini (gemini-3.1-flash-lite-preview) Express on :8001  <-- named stock_net
  + MCP SSE client                               |
                                           yahoo-finance2 + JSON file cache (/data/cache.json)
```

- Docker network: `stock_net`
- Server URL (inside Docker): `http://mcp-server:8001/sse`
- Server URL (from host, for local dev): `http://localhost:8001/sse`

---

## Directory Structure

```
2_http_cli_gemini/
├── 2_http_cli_gemini.md     ← this file
├── docker-compose.yml       ← two services: mcp-server + mcp-client, stock_net
├── .env.example             ← GEMINI_API_KEY=...
├── server/
│   ├── Dockerfile           ← node:24-alpine, expose :8001
│   ├── server.ts            ← same 4 MCP tools, HTTP/SSE transport (SSEServerTransport)
│   ├── cache.ts             ← copied unchanged from 1b_stdio_gemini
│   └── package.json         ← adds express; same mcp + yahoo-finance2
└── client/
    ├── Dockerfile           ← node:24-alpine, stdin_open + tty
    ├── cli.ts               ← same Gemini agentic loop; swap StdioClientTransport → SSEClientTransport
    └── package.json         ← same @google/generative-ai + @modelcontextprotocol/sdk
```

---

## What Changes vs `1b_stdio_gemini`

| Concern | `1b_stdio_gemini` | `2_http_cli_gemini` |
|---|---|---|
| MCP transport | `StdioClientTransport` (spawns subprocess) | `SSEClientTransport` (HTTP/SSE URL) |
| Containers | 1 (client + server in one image) | 2 (separate client + server images) |
| Server lifetime | per CLI session (child process) | long-running service |
| Server startup | `McpServer.connect(stdio)` | Express + `SSEServerTransport` per request |
| Cache volume | embedded in single container | named volume on server container |
| Dockerfile | single multi-stage image | two separate Dockerfiles |
| Gemini agentic loop | unchanged | unchanged |
| MCP tool definitions | unchanged | unchanged |

---

## Files to Copy Unchanged

| Source | Destination |
|---|---|
| `1b_stdio_gemini/server/cache.ts` | `server/cache.ts` |
| `1b_stdio_gemini/server/package.json` | base for `server/package.json` (add `express`) |
| `1b_stdio_gemini/server/tsconfig.json` | `server/tsconfig.json` |
| `1b_stdio_gemini/client/tsconfig.json` | `client/tsconfig.json` |

The Gemini agentic loop in `client/cli.ts` stays the same — only the MCP transport init block changes.

---

## Files to Create / Modify

| File | Action |
|---|---|
| `server/server.ts` | Modify: swap `StdioServerTransport` for Express + `SSEServerTransport` |
| `server/package.json` | Add `express` and `@types/express` deps |
| `server/Dockerfile` | New: node:24-alpine, install deps, expose 8001 |
| `client/cli.ts` | Modify: swap `StdioClientTransport` for `SSEClientTransport` |
| `client/package.json` | Same as `1b_stdio_gemini` — no changes needed |
| `client/Dockerfile` | New: node:24-alpine, stdin_open + tty |
| `docker-compose.yml` | New: two services on stock_net with named cache volume |
| `.env.example` | New: `GEMINI_API_KEY=...` |

---

## Implementation Details

### `server/server.ts` — HTTP/SSE Transport

Replace the stdio transport with an Express SSE server. The MCP tools stay identical.

```typescript
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
// ... same tool imports from 1b_stdio_gemini

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = parseInt(process.env.PORT ?? "8001");

const app = express();
app.use(express.json());

// One transport per SSE connection (clients reconnect, each gets a fresh transport)
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const server = new McpServer({ name: "stock-analyst", version: "1.0.0" });

  // Register all 4 tools (identical to 1b_stdio_gemini)
  // get_current_price, get_stock_overview, get_price_history, get_financials

  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  // SSEServerTransport handles the POST body (JSON-RPC messages from client)
  // The transport is stored per-connection — need a connection registry
  // See note below on transport registry
});

app.listen(PORT, HOST, () => {
  console.error(`MCP server listening on ${HOST}:${PORT}`);
});
```

**Connection registry pattern** (required for POST /messages):

```typescript
const transports = new Map<string, SSEServerTransport>();

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);
  res.on("close", () => transports.delete(transport.sessionId));

  const server = createMcpServer(); // factory that registers all tools
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);
  if (!transport) { res.status(404).end(); return; }
  await transport.handlePostMessage(req, res);
});
```

> **Note on console.log:** Never use `console.log` in the server — it goes to stdout which is no longer a JSON-RPC pipe in HTTP mode, but is still best avoided. Use `console.error` for all server logging.

---

### `client/cli.ts` — SSE Client Transport

Only the MCP connection setup changes. The Gemini agentic loop (`agentLoop` function) is identical to `1b_stdio_gemini/client/cli.ts`.

```typescript
// BEFORE (1b_stdio_gemini): stdio subprocess
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", path.join(__dirname, "..", "server", "server.ts")],
  env: { ...process.env } as Record<string, string>,
  stderr: "inherit",
});

// AFTER (2_http_cli_gemini): HTTP/SSE
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "http://localhost:8001/sse";

const transport = new SSEClientTransport(new URL(MCP_SERVER_URL));
```

Remove the `path` and `fileURLToPath` imports — they are no longer needed. Everything else in `main()` and `agentLoop()` is unchanged.

---

### `server/package.json`

```json
{
  "name": "stock-mcp-server",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "npx tsx server.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "express": "^4.21.0",
    "yahoo-finance2": "^2.13.3",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

---

### `server/Dockerfile`

```dockerfile
FROM node:24-alpine
WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .
RUN mkdir -p /data

ENV CACHE_FILE_PATH=/data/cache.json
ENV HOST=0.0.0.0
ENV PORT=8001

EXPOSE 8001
CMD ["npx", "tsx", "server.ts"]
```

---

### `client/Dockerfile`

```dockerfile
FROM node:24-alpine
WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

CMD ["npx", "tsx", "cli.ts"]
```

---

### `docker-compose.yml`

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
      - HOST=0.0.0.0
      - PORT=8001
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8001/health"]
      interval: 5s
      timeout: 3s
      retries: 5

  mcp-client:
    build: ./client
    depends_on:
      mcp-server:
        condition: service_healthy
    stdin_open: true
    tty: true
    environment:
      - GEMINI_API_KEY=${GEMINI_API_KEY}
      - MCP_SERVER_URL=http://mcp-server:8001/sse

networks:
  default:
    name: stock_net

volumes:
  stock_cache:
```

Add a `GET /health` route to `server.ts` for the healthcheck:

```typescript
app.get("/health", (_req, res) => res.json({ status: "ok" }));
```

---

### `.env.example`

```bash
GEMINI_API_KEY=your-key-here
```

---

## Build Order

1. `server/cache.ts` — copy from `1b_stdio_gemini/server/cache.ts` (unchanged)
2. `server/package.json` — copy + add `express` and `@types/express`
3. `server/tsconfig.json` — copy from `1b_stdio_gemini/server/tsconfig.json`
4. `server/server.ts` — rewrite with Express + `SSEServerTransport`; add `/health` route; copy all 4 MCP tools from `1b_stdio_gemini`
5. `server/Dockerfile` — new
6. `client/package.json` — copy from `1b_stdio_gemini/client/package.json` (unchanged)
7. `client/tsconfig.json` — copy from `1b_stdio_gemini/client/tsconfig.json`
8. `client/cli.ts` — copy from `1b_stdio_gemini/client/cli.ts`; swap transport init only
9. `client/Dockerfile` — new
10. `docker-compose.yml` — new
11. `.env.example` — new

---

## Key Gotchas

| Gotcha | Detail |
|---|---|
| Transport registry | `SSEServerTransport` is per-connection; POST /messages needs a `Map<sessionId, transport>` to route requests to the right connection |
| `sessionId` query param | `SSEClientTransport` appends `?sessionId=<uuid>` to POST requests automatically; the server must read `req.query.sessionId` |
| `depends_on` + healthcheck | Client container must wait for server to be ready; use a `GET /health` route + Docker healthcheck |
| Interactive Docker | `docker compose run --rm mcp-client` (not `up`) for the interactive CLI; or use `stdin_open: true` + `tty: true` with `docker compose up` + `docker attach` |
| `console.error` only in server | All server logging must go to stderr, not stdout |
| Remove path imports from client | `path` and `fileURLToPath` are only needed for subprocess spawn; remove when switching to SSE transport |
| `$schema` / `additionalProperties` strip | Already handled in `1b_stdio_gemini` client; carry the same tool-conversion code forward |

---

## Running

```bash
cd 2_http_cli_gemini
cp .env.example .env    # add GEMINI_API_KEY

# Start server in background, then attach interactive client
docker compose up --build -d mcp-server
docker compose run --rm mcp-client

# Or start everything and attach to client
docker compose up --build
docker attach 2_http_cli_gemini-mcp-client-1

# Local dev (no Docker)
MCP_SERVER_URL=http://localhost:8001/sse \
GEMINI_API_KEY=your-key \
  npx tsx client/cli.ts
```

---

## Verification Checklist

- [ ] `docker compose up --build -d mcp-server` starts and healthcheck passes
- [ ] `docker compose run --rm mcp-client` connects and prints tool count
- [ ] Ask "What is AAPL's current price?" — Gemini calls `get_current_price`, returns answer
- [ ] Ask a multi-tool question — verify parallel tool calls work (Gemini supports batching)
- [ ] Cache file appears in `stock_cache` volume after first query
- [ ] Second identical query returns cached data (no extra yahoo-finance API call)
- [ ] `docker compose down -v` cleanly removes network and volume
