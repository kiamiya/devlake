import { createServer, request, type Server } from 'node:http';
import type { Editor } from '../bridge.js';

const EDITOR_PREFIX = /^\/(unity|unreal|blender)(\/.*)?$/;

/**
 * Passerelle locale exposée par le tunnel : une seule URL publique, un chemin par éditeur.
 * `/unity/…` va au pont Unity, `/unreal/…` au pont Unreal (préfixe retiré). Le flux est
 * relayé tel quel (réponses en flux SSE comprises).
 */
export class BridgeGateway {
  private server: Server | null = null;

  constructor(
    /** Port local du pont d'un éditeur ; null s'il est arrêté. */
    private readonly target: (editor: Editor) => number | null,
    private readonly host = '127.0.0.1',
  ) {}

  get port(): number | null {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  async start(port: number): Promise<number> {
    if (this.server) return this.port ?? port;
    const server = createServer((req, res) => {
      const match = EDITOR_PREFIX.exec(new URL(req.url ?? '/', 'http://gateway').pathname);
      const editor = match?.[1] as Editor | undefined;
      if (editor === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Chemin attendu : /unity/…, /unreal/… ou /blender/….' }));
        return;
      }
      const targetPort = this.target(editor);
      if (targetPort === null) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `Pont ${editor} arrêté sur le poste.` }));
        return;
      }
      const url = new URL(req.url ?? '/', 'http://gateway');
      const path = `${match?.[2] ?? '/'}${url.search}`;
      const upstream = request(
        {
          host: '127.0.0.1',
          port: targetPort,
          method: req.method,
          path,
          headers: { ...req.headers, host: `127.0.0.1:${String(targetPort)}` },
        },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `Pont ${editor} injoignable.` }));
        } else res.destroy();
      });
      req.pipe(upstream);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, this.host, () => {
        resolve();
      });
    });
    this.server = server;
    return this.port ?? port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
}
