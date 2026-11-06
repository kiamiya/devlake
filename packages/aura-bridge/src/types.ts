import type { EditorId } from 'shared';

/** Éditeur servi par un pont : Unity, Unreal (Aura) ou Blender. */
export type Editor = EditorId;

/** Serveur MCP du poste : lancé en stdio (commande) ou joint en HTTP (URL locale). */
export type McpServerSpec =
  | { kind: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { kind: 'http'; url: string; headers: Record<string, string> };
