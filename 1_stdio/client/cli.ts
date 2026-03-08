import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as readline from "readline";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SYSTEM_PROMPT = `You are a stock research assistant with access to real-time and historical data for 8 major tech stocks: AAPL, AMZN, GOOGL, META, MSFT, NFLX, NVDA, and TSLA.

Use the available tools to answer questions accurately. When presenting financial data, format numbers clearly (e.g., use $ for prices, B/M for billions/millions, % for percentages). Always cite the data source as real-time or cached market data.`;

async function agentLoop(
  anthropic: Anthropic,
  mcpClient: Client,
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
      return (textBlock as Anthropic.TextBlock | undefined)?.text ?? "(no response)";
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
          const text =
            result.content[0]?.type === "text"
              ? (result.content[0] as { type: "text"; text: string }).text
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

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is required");
    process.exit(1);
  }

  const anthropic = new Anthropic({ apiKey });

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", path.join(__dirname, "..", "server", "server.ts")],
    env: { ...process.env } as Record<string, string>,
    stderr: "inherit",
  });

  const mcpClient = new Client({ name: "stock-cli", version: "1.0.0" }, { capabilities: {} });
  await mcpClient.connect(transport);

  const { tools: mcpTools } = await mcpClient.listTools();
  const anthropicTools: Anthropic.Tool[] = mcpTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
  }));

  console.log(`Stock Research CLI — ${mcpTools.length} tools loaded`);
  console.log("Tickers: AAPL, AMZN, GOOGL, META, MSFT, NFLX, NVDA, TSLA");
  console.log('Type your question or "exit" to quit.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const conversationHistory: Anthropic.MessageParam[] = [];

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
        const reply = await agentLoop(anthropic, mcpClient, conversationHistory, anthropicTools);
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
