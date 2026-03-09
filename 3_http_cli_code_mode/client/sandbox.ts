import vm from "node:vm";
import { transform } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";

export async function runInSandbox(
  code: string,
  mcpClient: Client,
  tools: Tool[]
): Promise<string> {
  const bindings: Record<string, unknown> = {};

  for (const tool of tools) {
    const paramNames = Object.keys(
      (tool.inputSchema.properties as Record<string, unknown>) ?? {}
    );

    bindings[tool.name] = async (...positional: unknown[]) => {
      // If the model already passed a named-arg object, use it directly.
      // Otherwise map positional args onto the schema's parameter names in order.
      const args =
        positional.length === 1 &&
        typeof positional[0] === "object" &&
        positional[0] !== null
          ? (positional[0] as Record<string, unknown>)
          : Object.fromEntries(paramNames.map((k, i) => [k, positional[i]]));

      const result = await mcpClient.callTool({ name: tool.name, arguments: args });
      const content = result.content as { type: string; text?: string }[];
      const first = content[0];
      if (!first || first.type !== "text") return content;
      try {
        return JSON.parse(first.text ?? "null");
      } catch {
        return first.text;
      }
    };
  }

  // Transpile TypeScript → JavaScript so type annotations don't cause vm syntax errors.
  const { code: jsCode } = await transform(code, { loader: "ts" });

  // Expose Promise so async/await inside the sandbox resolves correctly.
  const context = vm.createContext({ ...bindings, Promise, __result: undefined });

  const wrapped = `(async () => { ${jsCode}\n __result = await run(); })()`;
  await vm.runInContext(wrapped, context);

  return String(context.__result);
}
