# 1b_stdio_gemini Plan

## What This Is

A self-contained copy of `1_stdio` adapted to use the **Google Gemini API** (`gemini-3.1-flash-lite-preview`) instead of the Anthropic Claude API. The MCP server is identical — only the client changes.

```
You → CLI → Google GenAI SDK → Gemini (gemini-3.1-flash-lite-preview) → MCP Client → [stdin/stdout pipe] → MCP Server → Yahoo Finance
```

> **Note on model name:** Google's model is marketed as "Gemini Flash Lite" but the API model ID is `gemini-3.1-flash-lite`. 
---

## Why a Separate Directory

Each example is self-contained. No shared code, no symlinks. The server is duplicated by design so you can run and study either example independently.

---

## Directory Structure

```
1b_stdio_gemini/
  1b_stdio_gemini_plan.md  ← this file
  client/
    cli.ts          ← rewritten: @google/generative-ai SDK instead of @anthropic-ai/sdk
    package.json    ← swap @anthropic-ai/sdk for @google/generative-ai
    tsconfig.json   ← unchanged from 1_stdio
  server/
    server.ts       ← copied unchanged from 1_stdio
    cache.ts        ← copied unchanged from 1_stdio
    package.json    ← copied unchanged from 1_stdio
    tsconfig.json   ← copied unchanged from 1_stdio
  Dockerfile        ← swap ANTHROPIC_API_KEY for GEMINI_API_KEY
  docker-compose.yml← swap ANTHROPIC_API_KEY env var for GEMINI_API_KEY
  .env.example      ← GEMINI_API_KEY=your-key-here
```

---

## Key Differences: Anthropic vs Google GenAI SDK

| Concern | Anthropic SDK (`1_stdio`) | Google GenAI SDK (`1b_stdio_gemini`) |
|---|---|---|
| Package | `@anthropic-ai/sdk` | `@google/generative-ai` |
| Client init | `new Anthropic({ apiKey })` | `new GoogleGenerativeAI(apiKey)` |
| Model handle | passed to `messages.create()` | `client.getGenerativeModel({ model, tools, systemInstruction })` |
| System prompt | Separate `system:` param | `systemInstruction:` on `getGenerativeModel()` |
| Tool format | `input_schema` (JSON Schema) | `functionDeclarations[].parameters` (JSON Schema) |
| Chat session | stateless, pass full history | `model.startChat({ history })` — stateful |
| Send message | `anthropic.messages.create(...)` | `chat.sendMessage(userText)` |
| Stop signal | `stop_reason: "tool_use"` | response contains `functionCall` parts |
| Tool result | `role: "user"` + `tool_use_id` | `role: "function"` + `name` + `response` object |
| API key env | `ANTHROPIC_API_KEY` | `GEMINI_API_KEY` |

---

## Client Changes in Detail

### `package.json`
```json
{
  "dependencies": {
    "@google/generative-ai": "^0.21.0",
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

### Client init + model setup
```ts
import { GoogleGenerativeAI, Tool as GeminiTool } from "@google/generative-ai";

const MODEL = process.env.MODEL ?? "gemini-3.1-flash-lite-preview";
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
```

### Tool conversion (MCP → Gemini function declaration format)
```ts
const geminiTools: GeminiTool[] = [{
  functionDeclarations: mcpTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: t.inputSchema as Record<string, unknown>,
  })),
}];
```

### Model + chat session creation (per query)
The Gemini SDK uses a stateful `ChatSession`. Create a new chat per query, seeding it with the prior conversation history, or maintain a single chat session for the whole CLI session.

```ts
const model = genAI.getGenerativeModel({
  model: MODEL,
  tools: geminiTools,
  systemInstruction: SYSTEM_PROMPT,
});

const chat = model.startChat({ history: [] });
```

### Agent loop
```ts
async function agentLoop(chat: ChatSession, userMessage: string): Promise<string> {
  let result = await chat.sendMessage(userMessage);

  while (true) {
    const response = result.response;
    const parts = response.candidates?.[0]?.content?.parts ?? [];

    // Check for function calls
    const functionCallParts = parts.filter((p) => p.functionCall);
    if (functionCallParts.length === 0) {
      // No tool calls — return text
      return response.text();
    }

    // Execute all tool calls, collect function responses
    const functionResponses = await Promise.all(
      functionCallParts.map(async (part) => {
        const { name, args } = part.functionCall!;
        const mcpResult = await mcpClient.callTool({
          name,
          arguments: args as Record<string, unknown>,
        });
        const text =
          mcpResult.content[0]?.type === "text"
            ? mcpResult.content[0].text
            : JSON.stringify(mcpResult.content);
        return {
          functionResponse: { name, response: { content: text } },
        };
      })
    );

    // Send tool results back — Gemini expects a "function" role message
    result = await chat.sendMessage(functionResponses);
  }
}
```

### `main()` changes
- Check `GEMINI_API_KEY` instead of `ANTHROPIC_API_KEY`
- Instantiate `genAI` and create the model once
- Start a single `chat` session at startup (Gemini maintains history internally)
- Pass `chat` + `userInput` to `agentLoop` instead of `anthropic` + full history array

---

## Files to Copy Unchanged from `1_stdio`

- `server/server.ts`
- `server/cache.ts`
- `server/package.json`
- `server/tsconfig.json`
- `client/tsconfig.json`

---

## Files to Create / Modify

| File | Action |
|---|---|
| `client/cli.ts` | Rewrite: swap Anthropic SDK for `@google/generative-ai` |
| `client/package.json` | Swap `@anthropic-ai/sdk` → `@google/generative-ai` |
| `Dockerfile` | Replace `ANTHROPIC_API_KEY` env with `GEMINI_API_KEY` |
| `docker-compose.yml` | Replace `ANTHROPIC_API_KEY` with `GEMINI_API_KEY` |
| `.env.example` | `GEMINI_API_KEY=your-key-here` |

---

## Docker Notes

- No special networking needed — Gemini is a remote API like Anthropic
- Pass `GEMINI_API_KEY` as an environment variable; no `host.docker.internal` required
- `docker-compose.yml` is simpler than the Ollama variant

---

## Prerequisites

```bash
# Get a free Gemini API key from https://aistudio.google.com/app/apikey
export GEMINI_API_KEY=your-key-here

# Run locally
cd client && npm install && npm start

# Run via Docker
docker compose up --build
```
