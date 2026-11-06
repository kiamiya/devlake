import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AuraCommand } from './aura-command.js';
import type { McpServerSpec } from './types.js';

/** Serveur MCP du poste vu par le pont : port remplaçable par une doublure dans les tests. */
export interface AuraUpstream {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** Lance un serveur MCP en stdio (commande des réglages) et s'y connecte. */
export async function connectStdioUpstream(command: AuraCommand): Promise<AuraUpstream> {
  const transport = new StdioClientTransport({
    command: command.command,
    args: command.args,
    env: { ...(process.env as Record<string, string>), ...command.env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'agentlake-aura-bridge', version: '1.0.0' });
  await client.connect(transport);
  return clientUpstream(client);
}

/** Se connecte à un serveur MCP local en Streamable HTTP (serveur intégré à l'éditeur). */
export async function connectHttpUpstream(
  url: string,
  headers: Record<string, string> = {},
): Promise<AuraUpstream> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });
  const client = new Client({ name: 'agentlake-aura-bridge', version: '1.0.0' });
  await client.connect(transport);
  return clientUpstream(client);
}

/** Un serveur MCP selon sa configuration : stdio ou HTTP. */
export function connectMcpServer(spec: McpServerSpec): Promise<AuraUpstream> {
  return spec.kind === 'stdio'
    ? connectStdioUpstream(spec)
    : connectHttpUpstream(spec.url, spec.headers);
}

function clientUpstream(client: Client): AuraUpstream {
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
