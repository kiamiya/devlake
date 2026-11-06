import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectMultiUpstream, mcpServerFrom } from './mcp-servers.js';
import { connectMcpServer } from './upstream.js';

/** Serveur MCP HTTP minimal, comme un serveur intégré à l'éditeur (Unreal MCP…). */
function editorServer() {
  const mcp = () => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const server = new Server(
      { name: 'unreal-mcp', version: '1' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [{ name: 'spawn_actor', inputSchema: { type: 'object' as const } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) => ({
      content: [
        { type: 'text' as const, text: `acteur ${String(request.params.arguments?.name)}` },
      ],
    }));
    return server;
  };
  return createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body: unknown = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
        : undefined;
      // Sans état : un transport par requête.
      const transport = new StreamableHTTPServerTransport({});
      await mcp().connect(transport);
      await transport.handleRequest(req, res, body);
    })();
  });
}

describe('serveur MCP HTTP local derrière le pont', () => {
  let http: HttpServer;
  let url: string;

  beforeEach(async () => {
    http = editorServer();
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    url = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}/mcp`;
  });

  afterEach(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) =>
      http.close(() => {
        resolve();
      }),
    );
  });

  it('configuration collée → connexion HTTP → outils préfixés et appel', async () => {
    const spec = mcpServerFrom({ mcpServers: { unreal: { url } } });
    const multi = await connectMultiUpstream([
      { name: 'unreal', connect: () => connectMcpServer(spec) },
    ]);
    expect((await multi.listTools()).map((t) => t.name)).toEqual(['unreal__spawn_actor']);
    expect(await multi.callTool('unreal__spawn_actor', { name: 'Héros' })).toMatchObject({
      content: [{ type: 'text', text: 'acteur Héros' }],
    });
    await multi.close();
  });
});
