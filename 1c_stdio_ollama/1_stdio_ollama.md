# 1_stdio_ollama Plan

## What This Is

A self-contained copy of `1_stdio` adapted to use a **local Ollama LLM** (`qwen3.5:4b`) instead of the Anthropic Claude API. The MCP server is identical — only the client changes.

```
You → CLI → OpenAI SDK → Ollama (qwen3.5:4b) → MCP Client → [stdin/stdout pipe] → MCP Server → Yahoo Finance
```

---

## Why a Separate Directory

Each example is self-contained. No shared code, no symlinks. The server is duplicated by design so you can run and study either example independently.

---

## Directory Structure

```
1_stdio_ollama/
  client/
    cli.ts          ← rewritten: OpenAI SDK → Ollama instead of @anthropic-ai/sdk
    package.json    ← swap @anthropic-ai/sdk for openai
    tsconfig.json   ← unchanged from 1_stdio
  server/
    server.ts       ← copied unchanged from 1_stdio
    cache.ts        ← copied unchanged from 1_stdio
    package.json    ← copied unchanged from 1_stdio
    tsconfig.json   ← copied unchanged from 1_stdio
  Dockerfile        ← drop ANTHROPIC_API_KEY, add OLLAMA_BASE_URL + MODEL
  docker-compose.yml← network to host Ollama via host.docker.internal
  .env.example      ← swap ANTHROPIC_API_KEY for OLLAMA_BASE_URL + MODEL
```

---

## Key Differences: Anthropic vs OpenAI-compat (Ollama)

| Concern | Anthropic SDK (`1_stdio`) | OpenAI SDK → Ollama (`1_stdio_ollama`) |
|---|---|---|
| Package | `@anthropic-ai/sdk` | `openai` |
| Client init | `new Anthropic({ apiKey })` | `new OpenAI({ baseURL, apiKey: "ollama" })` |
| System prompt | Separate `system:` param | `{ role: "system", content }` in messages |
| Tool format | `input_schema`, `tool_use` blocks | `function.parameters`, `tool_calls[]` |
| Stop signal | `stop_reason: "tool_use"` | `finish_reason: "tool_calls"` |
| Tool result | `role: "user"` + `tool_use_id` | `role: "tool"` + `tool_call_id` |

---

## Client Changes in Detail

### `package.json`
```json
"dependencies": {
  "openai": "^4.x",
  "@modelcontextprotocol/sdk": "^1.0.0"
}
```

### Client init
```ts
const MODEL = process.env.MODEL ?? "qwen3.5:4b";
const client = new OpenAI({
  baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
  apiKey: "ollama",
});
```

### Tool conversion (MCP → OpenAI function format)
```ts
const openaiTools = mcpTools.map((t) => ({
  type: "function" as const,
  function: {
    name: t.name,
    description: t.description ?? "",
    parameters: t.inputSchema as Record<string, unknown>,
  },
}));
```

### System prompt in messages array
```ts
const conversationHistory: OpenAI.Chat.ChatCompletionMessageParam[] = [
  { role: "system", content: SYSTEM_PROMPT }
];
```

### Agent loop
```ts
while (true) {
  const response = await client.chat.completions.create({ model: MODEL, messages, tools });
  const choice = response.choices[0];
  messages.push(choice.message);

  if (choice.finish_reason === "stop") return choice.message.content ?? "(no response)";

  if (choice.finish_reason === "tool_calls") {
    for (const call of choice.message.tool_calls ?? []) {
      const result = await mcpClient.callTool({
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments),
      });
      const text = result.content[0]?.type === "text"
        ? result.content[0].text
        : JSON.stringify(result.content);
      messages.push({ role: "tool", tool_call_id: call.id, content: text });
    }
  }
}
```

---

## Docker Notes

- `OLLAMA_BASE_URL=http://host.docker.internal:11434/v1` — lets the container reach Ollama on the host
- `extra_hosts: host.docker.internal:host-gateway` — required on Linux (no-op on macOS Docker Desktop)
- No API key needed — just `MODEL` and `OLLAMA_BASE_URL`

---

## Prerequisites

```bash
ollama pull qwen3.5:4b
ollama serve  # if not already running
```
