#!/usr/bin/env node
// Faux serveur MCP Aura (stdio) pour les tests d'intégration du pont : trois outils.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'aura-factice', version: '0.0.1' });

server.registerTool(
  'scene_list',
  { description: 'Liste les scènes du projet.', inputSchema: {} },
  () => ({ content: [{ type: 'text', text: 'Main.unity, Menu.unity' }] }),
);
server.registerTool(
  'echo',
  { description: 'Renvoie le texte reçu.', inputSchema: { text: z.string() } },
  ({ text }) => ({ content: [{ type: 'text', text: `écho : ${text}` }] }),
);
server.registerTool(
  'run_script',
  { description: 'Exécute un script éditeur (dangereux).', inputSchema: {} },
  () => ({ content: [{ type: 'text', text: 'exécuté' }] }),
);

await server.connect(new StdioServerTransport());
