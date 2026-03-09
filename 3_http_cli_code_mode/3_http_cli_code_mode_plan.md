# Phase 3 Implementation Plan — `3_http_cli_code_mode/`

## Overview
Phase 3 swaps the `2_http_cli_gemini` multi-turn `functionCall` loop for Cloudflare's **Code Mode** pattern. Gemini writes a `run()` TypeScript function; a `vm.Script` sandbox executes it against MCP tool bindings. The server is copied unchanged.

---

## Step 1 — Scaffold the directory

Copy `2_http_cli_gemini/` as the starting point:

```
3_http_cli_code_mode/
├── docker-compose.yml         (copy + minor edit)
├── .env.example               (copy — same GEMINI_API_KEY)
├── server/                    (copy verbatim — no changes)
│   ├── Dockerfile
│   ├── server.ts
│   ├── cache.ts
│   └── package.json
└── client/
    ├── Dockerfile             (copy — no changes)
    ├── package.json           (copy — no changes)
    ├── tsconfig.json          (copy — no changes)
    ├── codegen.ts             (NEW)
    ├── sandbox.ts             (NEW)
    └── cli.ts                 (REPLACE — code mode loop)
```

---

## Step 2 — `client/codegen.ts` (new file)

Two pure functions:

1. **`mcpToolsToTypeScript(tools)`** — converts MCP tool schemas into TypeScript `async function` signatures (with JSDoc) that Gemini will see as "available in scope."
2. **`buildSystemPrompt(toolDefs)`** — wraps the TS sigs into a system prompt that instructs Gemini to return **only** a ` ```typescript ``` ` code block containing `run()`.

Key decision: use the existing `Tool` type from `@modelcontextprotocol/sdk/types.js` — no new dependencies.

---

## Step 3 — `client/sandbox.ts` (new file)

Uses Node's built-in `node:vm` module (no new deps):

1. Iterate `toolNames`, bind each as `async (args) => mcpClient.callTool(...)` in the sandbox context.
2. Wrap the generated code: `(async () => { ${code}\n __result = await run(); })()`
3. `vm.createContext({ ...bindings, __result: undefined })` → `vm.runInContext(wrapped, context)`
4. Return `String(context.__result)`

One subtlety: `vm.Script` context doesn't inherit `Promise` by default in some Node versions — pass `{ Promise }` in the context context object.

---

## Step 4 — `client/cli.ts` (rewrite)

Replace the multi-turn `functionCall` loop with code mode:

**Startup (once):**
```
listTools() → mcpToolsToTypeScript() → buildSystemPrompt()
model = getGenerativeModel({ model, systemInstruction })  // no tools: []
chat = model.startChat({ history: [] })
```

**Per turn:**
```
chat.sendMessageStream(userMessage)
  → stream generated TS to stdout  "[Gemini generating code…]"
  → extract ```typescript … ``` block
  → runInSandbox(code, mcpClient, toolNames)  → executes MCP calls
  → print answer
  → chat.sendMessage(`Tool execution result:\n${answer}`)  // keep context
```

Key differences from Phase 2:
- No `functionCallParts` loop
- No `functionResponse` objects fed back to Gemini
- One Gemini round-trip per user turn (plus one follow-up to inject the result)

---

## Step 5 — `docker-compose.yml`

Copy from `2_http_cli_gemini/docker-compose.yml` — identical. No port or network changes needed.

---

## Step 6 — `.env.example`

```
GEMINI_API_KEY=your_key_here
```

Same as Phase 2.

---

## Implementation sequence

| Order | File | Action |
|---|---|---|
| 1 | `server/` | `cp -r 2_http_cli_gemini/server 3_http_cli_code_mode/server` |
| 2 | `client/Dockerfile`, `package.json`, `tsconfig.json` | copy from Phase 2 client |
| 3 | `docker-compose.yml`, `.env.example` | copy from Phase 2 |
| 4 | `client/codegen.ts` | write from scratch |
| 5 | `client/sandbox.ts` | write from scratch |
| 6 | `client/cli.ts` | rewrite (remove `agentLoop`, add code mode loop) |

---

## Gotchas to watch for

- **`vm` + async**: wrap everything in `(async () => { ... })()` and `await` it; plain `vm.runInContext` won't resolve Promises otherwise.
- **`Promise` in sandbox context**: add `Promise` to the `vm.createContext` bindings explicitly so Gemini-generated `async/await` resolves correctly.
- **MCP tool arg shape**: Gemini may call `get_current_price("AAPL")` positionally; the sandbox binding receives the first positional arg — decide upfront whether to bind as `(ticker) =>` vs `(args) =>` and document it in the system prompt example.
- **Code block extraction**: Gemini sometimes wraps in ` ```ts ` or ` ```typescript ` — regex should handle both: `/```(?:typescript|ts)?\n([\s\S]*?)```/`
- **Chat history continuity**: after sandbox execution, feed the result back via `chat.sendMessage(...)` so follow-up questions have context without re-running tools.
