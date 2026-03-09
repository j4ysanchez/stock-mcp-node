import { Tool } from "@modelcontextprotocol/sdk/types.js";

export function mcpToolsToTypeScript(tools: Tool[]): string {
  return tools
    .map((t) => {
      const props =
        (t.inputSchema.properties as Record<
          string,
          { type: string; description?: string }
        >) ?? {};
      const params = Object.entries(props)
        .map(([k, v]) => `/** ${v.description ?? ""} */ ${k}: ${v.type}`)
        .join(", ");
      return `/** ${t.description} */\nasync function ${t.name}(${params}): Promise<any>;`;
    })
    .join("\n\n");
}

export function buildSystemPrompt(toolDefs: string): string {
  return `You are a stock research assistant. Answer the user's question by writing a \
single async TypeScript function called \`run()\` that uses the tools below.
Return ONLY the code block — no explanation, no markdown prose outside the code fence.

Available tools (already bound in scope — do NOT import or declare them):
\`\`\`typescript
${toolDefs}
\`\`\`

Rules:
- Always call \`run()\` with no arguments.
- Return a human-readable string from \`run()\`.
- You may call tools in parallel with \`Promise.all\`.
- Tickers available: AAPL, AMZN, GOOGL, META, MSFT, NFLX, NVDA, TSLA.

Example:
\`\`\`typescript
async function run() {
  const [price, overview] = await Promise.all([
    get_current_price("AAPL"),
    get_stock_overview("AAPL"),
  ]);
  return \`\${overview.shortName} trades at $\${price.price} (P/E \${overview.trailingPE})\`;
}
\`\`\``;
}
