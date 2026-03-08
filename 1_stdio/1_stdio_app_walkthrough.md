# 1_stdio App Walkthrough

## What This Project Is

A stock research chatbot. You type questions in natural language ("What's Apple's P/E ratio?"), and Claude figures out which MCP tool to call, calls it, and gives you a formatted answer. The architecture has two separate processes: a **server** that fetches stock data, and a **client** that talks to Claude and the server.

---

## The Big Picture: What is stdio MCP?

MCP (Model Context Protocol) is a standard for giving AI models access to tools. The "stdio" transport means the client and server communicate by literally writing to **stdin/stdout** — the same pipes you'd use to connect `cat` to `grep` in a shell. The client spawns the server as a child process and they exchange JSON messages over those pipes.

```
You → CLI → Claude API → MCP Client → [stdin/stdout pipe] → MCP Server → Yahoo Finance
```

---

## File Walkthrough

### server/server.ts

The core of the project. Key concepts:

**1. Creating the server**
```ts
const server = new McpServer({ name: "stock-mcp-server", version: "1.0.0" });
```
You give it a name/version — this is metadata the client sees when it connects.

**2. Registering a tool with `server.tool()`**
```ts
server.tool(
  "get_current_price",           // tool name
  "Get real-time price...",      // description (Claude reads this!)
  { ticker: z.enum(TICKERS) },   // input schema validated by Zod
  async ({ ticker }) => { ... }  // handler function
)
```
Four arguments: name, description, schema, handler. The **description is critical** — Claude reads it to decide which tool to call. The schema uses **Zod** for validation, which also auto-generates the JSON Schema that gets sent to Claude.

**3. Tool return format**
```ts
return { content: [{ type: "text", text: JSON.stringify(result) }] }
```
MCP tools always return `content` — an array of content blocks. Here it's always a single `"text"` block containing JSON.

**4. Connecting via stdio**
```ts
const transport = new StdioServerTransport();
await server.connect(transport);
```
This is the last two lines of the file. The server just... waits. It reads from stdin and writes to stdout. No HTTP port, no web server — just pipes.

**5. `as const` on the tickers array**
```ts
const TICKERS = ["AAPL", "AMZN", ...] as const;
```
`as const` makes TypeScript treat the array as a readonly tuple of literal types. This lets `z.enum(TICKERS)` work — Zod needs a literal union, not just `string[]`.

---

### server/cache.ts

A simple file-based cache. Key concepts:

**1. Different TTLs per data type** — stock prices go stale in 15 minutes, but financial statements are valid for a week:
```ts
export const TTL = {
  PRICE:      15 * 60 * 1000,           // 15 min
  OVERVIEW:    1 * 60 * 60 * 1000,      // 1 hour
  HISTORY:    24 * 60 * 60 * 1000,      // 1 day
  FINANCIALS:  7 * 24 * 60 * 60 * 1000, // 1 week
};
```

**2. Read → modify → write pattern** — each `cacheGet`/`cacheSet` reads and writes the whole JSON file. Simple but not concurrent-safe. Fine for a CLI where one person uses it at a time.

**3. Cache invalidation by TTL** — no active expiry, just checked on read:
```ts
if (Date.now() - entry.ts > ttlMs) return null;
```

**4. TypeScript generics** — `cacheGet<T>` returns `T | null`. The caller provides the type, e.g. `cacheGet<object>(key, TTL.PRICE)`.

**5. `CACHE_FILE_PATH` env var** — allows Docker to redirect the cache to a mounted volume instead of inside the container:
```ts
const CACHE_FILE = process.env.CACHE_FILE_PATH ?? path.join(__dirname, "..", "data", "cache.json");
```

---

### client/cli.ts

The CLI that connects everything. Key concepts:

**1. Spawning the server as a subprocess**
```ts
const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", path.join(__dirname, "..", "server", "server.ts")],
});
```
The client literally starts the server as a child process. `tsx` runs TypeScript directly without a compile step.

**2. Discovering tools at runtime**
```ts
const { tools: mcpTools } = await mcpClient.listTools();
```
The client asks the server "what tools do you have?" over the stdio pipe. This is how Claude learns what's available — you don't hardcode it.

**3. Converting MCP tools → Anthropic API format**
```ts
const anthropicTools: Anthropic.Tool[] = mcpTools.map((t) => ({
  name: t.name,
  description: t.description ?? "",
  input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
}));
```
MCP and the Anthropic SDK use slightly different shapes. This mapping bridges them.

**4. The agent loop** — this is the heart of how tool use works with Claude:
```ts
while (true) {
  const response = await anthropic.messages.create({ tools, messages });

  if (response.stop_reason === "end_turn") return response; // done

  if (response.stop_reason === "tool_use") {
    // execute each tool call
    // push results back into messages
    // loop again → Claude sees results and continues
  }
}
```
Claude doesn't call tools itself — it returns a `tool_use` block saying "I want to call X with args Y." Your code calls the tool, sends the result back, and Claude continues. The loop runs until Claude says `"end_turn"`.

**5. Conversation history** — `conversationHistory` is never cleared between questions. Each turn appends to it, so Claude remembers context across the session.

**6. ESM `__dirname` workaround**
```ts
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
```
In Node.js ES Modules (`"type": "module"` in package.json), `__dirname` doesn't exist. This is the standard workaround to reconstruct it.

---

### Dockerfile + docker-compose.yml

**Key Docker concepts here:**

**Install dependencies before copying source** — this is a layer caching optimization:
```dockerfile
COPY server/package.json ./server/
RUN cd server && npm install     # this layer is cached unless package.json changes
COPY server/ ./server/           # source changes don't invalidate the npm install layer
```

**`stdin_open: true` + `tty: true`** in docker-compose — without these, Docker closes stdin immediately and the interactive CLI can't read your input.

**Named volume for cache persistence:**
```yaml
volumes:
  - stock_cache:/data
```
The cache survives container restarts. If you stop and restart the container, you won't re-fetch data that's still fresh.

---

### package.json files

**Server dependencies:**
- `@modelcontextprotocol/sdk` — the MCP framework
- `yahoo-finance2` — stock data API (unofficial Yahoo Finance wrapper)
- `zod` — schema validation and type inference

**Client dependencies:**
- `@anthropic-ai/sdk` — Claude API client
- `@modelcontextprotocol/sdk` — MCP client

**`"type": "module"`** — opts the whole package into ES Module syntax (`import`/`export` instead of `require`/`module.exports`).

**`tsx`** — runs TypeScript files directly in Node without a separate compile step. Used in `npm start`.

---

## The Key Insight

The clever part of this architecture is that **Claude never directly calls any function**. The flow is:

1. You ask a question in plain English
2. Claude decides which MCP tool(s) to call and with what arguments
3. Your code (the agent loop) actually calls the tool via the MCP client
4. The result goes back to Claude as a message
5. Claude reasons over the data and writes a human-friendly answer

The MCP server is just a well-defined interface — Claude learns its capabilities by reading the tool names and descriptions you registered. This is why writing good descriptions in `server.tool()` matters so much.
