import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AuraCommand } from './aura-command.js';

/** Serveur MCP d'Aura vu par le pont : port remplaçable par une doublure dans les tests. */
export interface AuraUpstream {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** Lance le serveur MCP d'Aura en stdio (commande des réglages) et s'y connecte. */
export async function connectStdioUpstream(command: AuraCommand): Promise<AuraUpstream> {
  const transport = new StdioClientTransport({
    command: command.command,
    args: command.args,
    env: { ...(process.env as Record<string, string>), ...command.env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'agentlake-aura-bridge', version: '1.0.0' });
  await client.connect(transport);
  return {
    listTools: async () => {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return tools;
    },
    callTool: async (name, args) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: () => client.close(),
  };
}
