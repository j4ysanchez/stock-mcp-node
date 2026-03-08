# Phase 1 — `1_stdio/` Implementation Plan

## Files to Create (9 total)

```
1_stdio/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── cache.ts
│   └── server.ts
└── client/
    ├── package.json
    ├── tsconfig.json
    └── cli.ts
```

No root `package.json` — each sub-package is self-contained. A single Docker image houses both.

---

## Key Decisions

| Decision | Choice | Reason |
|---|---|---|
| Module system | CJS (`"type": "commonjs"`) | Avoids ESM interop friction with yahoo-finance2 and its deps |
| TS runner | `tsx` (esbuild-based) | Zero config, fast, no build step, works with CJS subpath imports |
| MCP Server API | `McpServer` + zod | `McpServer.tool()` accepts `ZodRawShape` and auto-generates JSON Schema — no manual schema writing |
| Cache storage | Flat JSON file read/written synchronously | File is tiny (<50KB for 8 tickers); sync avoids async complexity in tool handlers |

---

## Build Order

1. **`server/package.json` + `server/tsconfig.json`** — verify `npm install` and `tsx` work
2. **`server/cache.ts`** — foundation; all tools depend on it. Test independently before server.ts
3. **`server/server.ts` (stubs)** — 4 tools returning hardcoded JSON; validate MCP handshake
4. **Wire one tool end-to-end** — implement `get_current_price` fully with yahoo-finance2 + cache
5. **`client/package.json` + `client/tsconfig.json` + `client/cli.ts` (minimal)** — spawn subprocess, call `listTools()`, verify MCP handshake works
6. **Full agentic loop in `cli.ts`** — add Anthropic SDK, tool conversion, the `agentLoop` function
7. **Remaining 3 server tools** — `get_stock_overview`, `get_price_history`, `get_financials`
8. **`Dockerfile` + `docker-compose.yml`** — build and verify interactive Docker session
9. **Smoke test** all 4 tools via the CLI

---

## Critical Implementation Details

### `server/cache.ts`

- Cache key format: `"toolName:ticker"` or `"toolName:ticker:period"` (period must be in key for history to avoid collisions)
- Cache file path from env: `process.env.CACHE_FILE_PATH ?? '/data/cache.json'`
- Read entire JSON file on every `cacheGet`; write entire file on every `cacheSet` — fine at this scale
- Create `/data` dir at module load: `fs.mkdirSync(dir, { recursive: true })`
- TTL constants: PRICE=15min, OVERVIEW=1hr, HISTORY=24hr, FINANCIALS=7days

**Cache store shape:**
```ts
interface CacheStore {
  [key: string]: {
    data: unknown;
    ts: number;  // Unix ms timestamp
  };
}
```

**API surface:**
```ts
export function cacheGet<T>(key: string, ttlMs: number): T | null
export function cacheSet(key: string, data: unknown): void
export function cacheKey(...parts: string[]): string  // joins with ":"

export const TTL = {
  PRICE:      15 * 60 * 1000,
  OVERVIEW:    1 * 60 * 60 * 1000,
  HISTORY:    24 * 60 * 60 * 1000,
  FINANCIALS:  7 * 24 * 60 * 60 * 1000,
}
```

---

### `server/server.ts`

- **Critical:** Never use `console.log` — it corrupts the stdio JSON-RPC stream. Use `console.error` only.
- Suppress yahoo-finance2 validation noise: `yahooFinance.setGlobalConfig({ validation: { logErrors: false } })`
- Each tool wraps yahoo-finance2 calls in try/catch and returns errors as content text so Claude can relay them gracefully

**Tool registration pattern:**
```ts
const TICKERS = ["AAPL","AMZN","GOOGL","META","MSFT","NFLX","NVDA","TSLA"] as const;

server.tool(
  "get_current_price",
  "Get real-time price, change, volume, and market cap for a stock ticker",
  { ticker: z.enum(TICKERS).describe("Stock ticker symbol") },
  async ({ ticker }) => {
    const key = cacheKey("price", ticker);
    const cached = cacheGet<PriceResult>(key, TTL.PRICE);
    if (cached) return { content: [{ type: "text", text: JSON.stringify(cached) }] };
    // ... fetch from yahoo-finance2, cacheSet, return
  }
);
```

**Tool data sources:**

| Tool | yahoo-finance2 call | Key fields |
|---|---|---|
| `get_current_price` | `yahooFinance.quote(ticker)` | `regularMarketPrice`, `regularMarketChange`, `regularMarketChangePercent`, `regularMarketVolume`, `marketCap` |
| `get_stock_overview` | `yahooFinance.quoteSummary(ticker, { modules: ["price","summaryDetail","defaultKeyStatistics","assetProfile"] })` | `shortName`, `sector`, `trailingPE`, `fiftyTwoWeekHigh/Low`, `beta`, `longBusinessSummary` |
| `get_price_history` | `yahooFinance.historical(ticker, { period1, interval: "1d" })` | Map each row: `{date,open,high,low,close,volume}` |
| `get_financials` | `yahooFinance.fundamentalsTimeSeries(ticker, { type: "annual", module: "financials" })` + `quoteSummary` for EPS | `annualTotalRevenue`, `annualNetIncome`, `annualGrossProfit`, `trailingEps` |

**`get_price_history` period→date offset:**
```ts
const PERIOD_DAYS: Record<string, number> = { "5d": 5, "1mo": 30, "3mo": 90, "1y": 365 };
const period1 = new Date();
period1.setDate(period1.getDate() - PERIOD_DAYS[period]);
```

**`get_financials` note:** Use `fundamentalsTimeSeries` with `type: "annual"` — the `incomeStatementHistory*` modules were deprecated Nov 2024 and return almost no data.

**Transport startup:**
```ts
const transport = new StdioServerTransport();
await server.connect(transport);
```

---

### `client/cli.ts`

- Spawn server with absolute path: `args: ["tsx", path.join(__dirname, "..", "server", "server.ts")]`
- Set `stderr: "inherit"` on the transport so server-side `console.error` appears in the terminal
- MCP `inputSchema` maps directly to Anthropic `input_schema` — no deep transformation needed
- `conversationHistory` persists across turns — allows follow-up questions within a session
- On `SIGINT`: `await mcpClient.close()` to cleanly terminate the subprocess

**MCP client setup:**
```ts
const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", path.join(__dirname, "..", "server", "server.ts")],
  env: { ...process.env },
  stderr: "inherit",
});

const mcpClient = new Client(
  { name: "stock-cli", version: "1.0.0" },
  { capabilities: {} }
);
await mcpClient.connect(transport);
```

**Tool conversion (MCP → Anthropic):**
```ts
const { tools: mcpTools } = await mcpClient.listTools();
const anthropicTools: Anthropic.Tool[] = mcpTools.map((t) => ({
  name: t.name,
  description: t.description ?? "",
  input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
}));
```

---

## Agentic Loop Pattern

```
user input
    → push to conversationHistory
    → anthropic.messages.create({ model, tools, messages })
    → if stop_reason === "tool_use":
          for each tool_use block:
              mcpClient.callTool({ name, arguments })
              collect tool_result
          push all tool_results as user turn
          loop
    → if stop_reason === "end_turn":
          extract text block, print to user
          return to readline prompt
```

**Implementation:**
```ts
async function agentLoop(
  anthropic: Anthropic,
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[]
): Promise<string> {
  while (true) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock?.text ?? "(no response)";
    }

    if (response.stop_reason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        try {
          const result = await mcpClient.callTool({
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          });
          const text = result.content[0]?.type === "text"
            ? result.content[0].text
            : JSON.stringify(result.content);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: text });
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
    }
  }
}
```

---

## Package Dependencies

| Package | Server | Client | Purpose |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | yes | yes | `McpServer`/`StdioServerTransport` + `Client`/`StdioClientTransport` |
| `yahoo-finance2` | yes | no | Real-time quote, historical, fundamentals |
| `zod` | yes | no | Tool input schema (required by `McpServer.tool()`) |
| `@anthropic-ai/sdk` | no | yes | Claude API with tool_use |
| `tsx` | dev | dev | Run TypeScript directly — no compile step |
| `typescript` | dev | dev | Types |
| `@types/node` | dev | dev | Node.js type definitions |

---

## Docker Setup

### `Dockerfile`

```dockerfile
FROM node:24-alpine

WORKDIR /app

COPY server/package.json ./server/
RUN cd server && npm install

COPY client/package.json ./client/
RUN cd client && npm install

COPY server/ ./server/
COPY client/ ./client/

RUN mkdir -p /data

ENV CACHE_FILE_PATH=/data/cache.json

CMD ["npx", "--prefix", "client", "tsx", "client/cli.ts"]
```

### `docker-compose.yml`

```yaml
services:
  app:
    build: .
    stdin_open: true   # required for readline
    tty: true          # required for readline
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - CACHE_FILE_PATH=/data/cache.json
    volumes:
      - stock_cache:/data

volumes:
  stock_cache:
```

**Run with** `docker compose run --rm app` (not `up`) — `run` attaches an interactive TTY.

---

## Gotchas

| Gotcha | Detail |
|---|---|
| `console.log` in server | Corrupts the stdio JSON-RPC stream — use `console.error` only |
| yahoo-finance2 validation warnings | Suppress with `setGlobalConfig({ validation: { logErrors: false } })` |
| `null` fields from yahoo | Some fields (e.g. P/E for no-earnings companies) return `null/undefined` — use `?? null` and pass through |
| Cache key collision | Always include all variable dimensions — e.g. `"history:AAPL:3mo"` not just `"history:AAPL"` |
| `fundamentalsTimeSeries` | Use for financials, not `incomeStatementHistory` (deprecated Nov 2024) |
| Docker interactive mode | Must use `stdin_open: true` + `tty: true` + `docker compose run` (not `up`) |
| Server path in client | Use `path.join(__dirname, "..", "server", "server.ts")` — absolute path avoids cwd issues |
