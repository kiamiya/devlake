import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { PlanTask } from 'shared';
import { useMemo } from 'react';
import { depths, PROFILE_COLORS } from './profiles.js';

const COLUMN = 220;
const ROW = 90;

/** Graphe des dépendances : une colonne par profondeur, une couleur par profil. */
export function PlanGraph({
  tasks,
  onSelect,
}: {
  tasks: readonly PlanTask[];
  onSelect: (id: string) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const depth = depths(tasks);
    const rows = new Map<number, number>();
    const nodes: Node[] = tasks.map((task) => {
      const column = depth.get(task.id) ?? 0;
      const row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      return {
        id: task.id,
        position: { x: column * COLUMN, y: row * ROW },
        data: { label: `${task.id} — ${task.title}` },
        style: {
          borderColor: PROFILE_COLORS[task.profile],
          borderWidth: 2,
          fontSize: 12,
          width: 180,
        },
      };
    });
    const ids = new Set(tasks.map((t) => t.id));
    const edges: Edge[] = tasks.flatMap((task) =>
      task.dependencies
        .filter((d) => ids.has(d))
        .map((dep) => ({ id: `${dep}->${task.id}`, source: dep, target: task.id })),
    );
    return { nodes, edges };
  }, [tasks]);

  return (
    <div aria-label="Graphe des dépendances" className="h-[28rem] rounded-md border border-border">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={(_event, node) => {
          onSelect(node.id);
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
