import { GoogleGenerativeAI, Tool as GeminiTool, ChatSession } from "@google/generative-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as readline from "readline";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODEL = process.env.MODEL ?? "gemini-3.1-flash-lite-preview";

const SYSTEM_PROMPT = `You are a stock research assistant with access to real-time and historical data for 8 major tech stocks: AAPL, AMZN, GOOGL, META, MSFT, NFLX, NVDA, and TSLA.

Use the available tools to answer questions accurately. When presenting financial data, format numbers clearly (e.g., use $ for prices, B/M for billions/millions, % for percentages). Always cite the data source as real-time or cached market data.`;

async function agentLoop(chat: ChatSession, mcpClient: Client, userMessage: string): Promise<string> {
  let result = await chat.sendMessage(userMessage);

  while (true) {
    const response = result.response;
    const parts = response.candidates?.[0]?.content?.parts ?? [];

    const functionCallParts = parts.filter((p) => p.functionCall);
    if (functionCallParts.length === 0) {
      return response.text();
    }

    const functionResponses = await Promise.all(
      functionCallParts.map(async (part) => {
        const { name, args } = part.functionCall!;
        try {
          const mcpResult = await mcpClient.callTool({
            name,
            arguments: args as Record<string, unknown>,
          });
          const content = mcpResult.content as { type: string; text?: string }[];
          const first = content[0];
          const text = first?.type === "text" ? first.text ?? "" : JSON.stringify(content);
          return { functionResponse: { name, response: { content: text } } };
        } catch (err) {
          return {
            functionResponse: {
              name,
              response: { content: `Error: ${err instanceof Error ? err.message : String(err)}` },
            },
          };
        }
      })
    );

    result = await chat.sendMessage(functionResponses);
  }
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Error: GEMINI_API_KEY environment variable is required");
    process.exit(1);
  }

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", path.join(__dirname, "..", "server", "server.ts")],
    env: { ...process.env } as Record<string, string>,
    stderr: "inherit",
  });

  const mcpClient = new Client({ name: "stock-cli", version: "1.0.0" }, { capabilities: {} });
  await mcpClient.connect(transport);

  const { tools: mcpTools } = await mcpClient.listTools();

  const geminiTools: GeminiTool[] = [
    {
      functionDeclarations: mcpTools.map((t) => {
        const { $schema, additionalProperties, ...parameters } = t.inputSchema as Record<string, unknown>;
        void $schema; void additionalProperties;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { name: t.name, description: t.description ?? "", parameters: parameters as any };
      }),
    },
  ];

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    tools: geminiTools,
    systemInstruction: SYSTEM_PROMPT,
  });

  const chat = model.startChat({ history: [] });

  console.log(`Stock Research CLI (Gemini) — ${mcpTools.length} tools loaded`);
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
        const reply = await agentLoop(chat, mcpClient, trimmed);
        console.log(`\nAssistant: ${reply}\n`);
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
