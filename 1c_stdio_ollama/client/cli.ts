import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as readline from "readline";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODEL = process.env.MODEL ?? "gemma3:4b";

const SYSTEM_PROMPT = `You are a stock research assistant with access to real-time and historical data for 8 major tech stocks: AAPL, AMZN, GOOGL, META, MSFT, NFLX, NVDA, and TSLA.

Use the available tools to answer questions accurately. When presenting financial data, format numbers clearly (e.g., use $ for prices, B/M for billions/millions, % for percentages). Always cite the data source as real-time or cached market data.`;

async function agentLoop(
  client: OpenAI,
  mcpClient: Client,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  tools: OpenAI.Chat.ChatCompletionTool[]
): Promise<string> {
  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools,
    });

    const choice = response.choices[0];
    messages.push(choice.message);

    if (choice.finish_reason === "stop") {
      return choice.message.content ?? "(no response)";
    }

    if (choice.finish_reason === "tool_calls") {
      for (const call of choice.message.tool_calls ?? []) {
        try {
          const result = await mcpClient.callTool({
            name: call.function.name,
            arguments: JSON.parse(call.function.arguments) as Record<string, unknown>,
          });
          const content = result.content as { type: string; text?: string }[];
          const text =
            content[0]?.type === "text"
              ? content[0].text ?? ""
              : JSON.stringify(content);
          messages.push({ role: "tool", tool_call_id: call.id, content: text });
        } catch (err) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
  }
}

async function main() {
  const baseURL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";

  const client = new OpenAI({
    baseURL,
    apiKey: "ollama",
  });

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", path.join(__dirname, "..", "server", "server.ts")],
    env: { ...process.env } as Record<string, string>,
    stderr: "inherit",
  });

  const mcpClient = new Client({ name: "stock-cli", version: "1.0.0" }, { capabilities: {} });
  await mcpClient.connect(transport);

  const { tools: mcpTools } = await mcpClient.listTools();
  const openaiTools: OpenAI.Chat.ChatCompletionTool[] = mcpTools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));

  console.log(`Stock Research CLI (${MODEL}) — ${mcpTools.length} tools loaded`);
  console.log("Tickers: AAPL, AMZN, GOOGL, META, MSFT, NFLX, NVDA, TSLA");
  console.log('Type your question or "exit" to quit.\n');

  const conversationHistory: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

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

      conversationHistory.push({ role: "user", content: trimmed });

      try {
        const reply = await agentLoop(client, mcpClient, conversationHistory, openaiTools);
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
