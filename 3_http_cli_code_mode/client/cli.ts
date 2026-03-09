import { GoogleGenerativeAI, ChatSession } from "@google/generative-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import * as readline from "readline";
import { mcpToolsToTypeScript, buildSystemPrompt, FORMAT_INSTRUCTION } from "./codegen.js";
import { runInSandbox } from "./sandbox.js";

const MODEL = process.env.MODEL ?? "gemini-3.1-flash-lite-preview";
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "http://localhost:8001/sse";

// Extract a fenced code block (```javascript, ```typescript, ```ts, or plain ```) from model output.
function extractCodeBlock(raw: string): string {
  const match = raw.match(/```(?:javascript|typescript|ts|js)?\n([\s\S]*?)```/);
  if (!match) throw new Error(`No code block found in model response:\n${raw}`);
  return match[1];
}

async function agentTurn(
  chat: ChatSession,
  mcpClient: Client,
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"],
  userMessage: string
): Promise<void> {
  // Ask Gemini to write a run() function — stream the generated code.
  const streamResult = await chat.sendMessageStream(userMessage);

  process.stdout.write("\n[Gemini generating code...]\n");
  let raw = "";
  for await (const chunk of streamResult.stream) {
    const text = chunk.text();
    if (text) {
      process.stdout.write(text);
      raw += text;
    }
  }
  await streamResult.response; // ensure fully resolved

  // Extract and execute the TypeScript code block.
  const code = extractCodeBlock(raw);

  process.stdout.write("\n\n[Executing...]\n");
  const rawJson = await runInSandbox(code, mcpClient, tools);

  // Step 2: feed the raw data back and ask Gemini to format it.
  process.stdout.write("[Formatting...]\n\nAssistant: ");
  const formatStream = await chat.sendMessageStream(
    `Raw data:\n${rawJson}\n\n${FORMAT_INSTRUCTION}`
  );
  let answer = "";
  for await (const chunk of formatStream.stream) {
    const text = chunk.text();
    if (text) { process.stdout.write(text); answer += text; }
  }
  await formatStream.response;
  process.stdout.write("\n\n");
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Error: GEMINI_API_KEY environment variable is required");
    process.exit(1);
  }

  // Connect to the MCP server over SSE.
  const transport = new SSEClientTransport(new URL(MCP_SERVER_URL));
  const mcpClient = new Client({ name: "stock-cli-code-mode", version: "1.0.0" }, { capabilities: {} });
  await mcpClient.connect(transport);

  // Build the system prompt from live tool schemas.
  const { tools: mcpTools } = await mcpClient.listTools();
  const toolDefs = mcpToolsToTypeScript(mcpTools);
  const systemPrompt = buildSystemPrompt(toolDefs);

  // Initialise Gemini — no tools: [] array, code mode replaces function calling.
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: systemPrompt,
  });
  const chat = model.startChat({ history: [] });

  console.log(`Stock Research CLI (Gemini Code Mode) — ${mcpTools.length} tools loaded`);
  console.log("Tickers: AAPL, AMZN, GOOGL, META, MSFT, NFLX, NVDA, TSLA");
  console.log('Type your question or "exit" to quit.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  process.on("SIGINT", async () => {
    console.log("\nExiting...");
    await mcpClient.close();
    rl.close();
    process.exit(0);
  });

  const ask = () => {
    rl.question("You: ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed.toLowerCase() === "exit") {
        console.log("Goodbye!");
        await mcpClient.close();
        rl.close();
        return;
      }

      try {
        await agentTurn(chat, mcpClient, mcpTools, trimmed);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }

      ask();
    });
  };

  ask();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
