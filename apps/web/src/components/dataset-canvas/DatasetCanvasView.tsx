import { useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { DatasetCanvasEdge, DatasetCanvasNode } from "./canvas-types";
import ResourceNode from "./ResourceNode";

type DatasetCanvasViewProps = {
  nodes: DatasetCanvasNode[];
  edges: DatasetCanvasEdge[];
  selectedNodeId?: string | null;
  selectedEdgeId?: string | null;
  onSelectNode?: (nodeId: string) => void;
  onSelectEdge?: (edgeId: string) => void;
  onMoveNode?: (nodeId: string, position: { x: number; y: number }) => void;
  onToggleField?: (nodeId: string, fieldId: string, selected: boolean) => void;
  onToggleNodeCleanMode?: (nodeId: string) => void;
  onCreateJoin?: (sourceNodeId: string, targetNodeId: string) => void;
  onDropResource?: (
    resource: {
      resourceId: string;
      label: string;
      datasourceId: string;
      fields: Array<{ name: string; type: string }>;
    },
    position: { x: number; y: number },
  ) => void;
  onBackgroundClick?: () => void;
};

const getInitialZoom = (): number => {
  if (typeof window === "undefined") return 1;
  const width = window.innerWidth;
  if (width <= 1366) return 0.82;
  if (width <= 1536) return 0.9;
  return 1;
};

const DatasetCanvasView = ({
  nodes,
  edges,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  onMoveNode,
  onToggleField,
  onToggleNodeCleanMode,
  onCreateJoin,
  onDropResource,
  onBackgroundClick,
}: DatasetCanvasViewProps) => {
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [joinSourceNodeId, setJoinSourceNodeId] = useState<string | null>(null);
  const [cursorPosition, setCursorPosition] = useState<{ x: number; y: number } | null>(null);
  const [isDropOver, setIsDropOver] = useState(false);
  const [cleanModeByNodeId, setCleanModeByNodeId] = useState<Record<string, boolean>>({});
  const [zoom, setZoom] = useState(() => getInitialZoom());
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const dragDeltaRef = useRef<{ dx: number; dy: number } | null>(null);
  const panStartRef = useRef<{ pointerX: number; pointerY: number; originX: number; originY: number } | null>(null);

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const drawableEdges = useMemo(
    () =>
      edges
        .map((edge) => {
          const sourceNode = nodeById.get(edge.source);
          const targetNode = nodeById.get(edge.target);
          if (!sourceNode || !targetNode) return null;
          return { edge, sourceNode, targetNode };
        })
        .filter((item): item is { edge: DatasetCanvasEdge; sourceNode: DatasetCanvasNode; targetNode: DatasetCanvasNode } => !!item),
    [edges, nodeById],
  );
  const relatedFieldsByNode = useMemo(() => {
    const related = new Map<string, Set<string>>();
    edges.forEach((edge) => {
      const sourceSet = related.get(edge.source) || new Set<string>();
      const targetSet = related.get(edge.target) || new Set<string>();
      edge.data.conditions.forEach((condition) => {
        if (condition.leftColumn) sourceSet.add(condition.leftColumn);
        if (condition.rightColumn) targetSet.add(condition.rightColumn);
      });
      related.set(edge.source, sourceSet);
      related.set(edge.target, targetSet);
    });
    return related;
  }, [edges]);

  return (
    <div
      className={cn(
        "relative h-[620px] overflow-hidden rounded-2xl border border-border bg-[radial-gradient(circle_at_1px_1px,hsl(var(--muted-foreground)/0.14)_1px,transparent_0)] [background-size:22px_22px] select-none",
        isPanning ? "cursor-grabbing" : "cursor-grab",
        isDropOver && "border-accent/60 shadow-[0_0_0_1px_hsl(var(--accent)/0.32)]",
      )}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("[data-canvas-interactive='true']")) return;
        setJoinSourceNodeId(null);
        setCursorPosition(null);
        onBackgroundClick?.();
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("application/x-istari-resource")) return;
        event.preventDefault();
        if (!isDropOver) setIsDropOver(true);
      }}
      onPointerMove={(event) => {
        if (isPanning && panStartRef.current) {
          const dx = event.clientX - panStartRef.current.pointerX;
          const dy = event.clientY - panStartRef.current.pointerY;
          setPan({ x: panStartRef.current.originX + dx, y: panStartRef.current.originY + dy });
          return;
        }
        if (!joinSourceNodeId) return;
        const rect = event.currentTarget.getBoundingClientRect();
        setCursorPosition({
          x: (event.clientX - rect.left - pan.x) / zoom,
          y: (event.clientY - rect.top - pan.y) / zoom,
        });
      }}
      onPointerUp={() => {
        setIsPanning(false);
        panStartRef.current = null;
      }}
      onPointerCancel={() => {
        setIsPanning(false);
        panStartRef.current = null;
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setIsDropOver(false);
      }}
      onDrop={(event) => {
        setIsDropOver(false);
        const raw = event.dataTransfer.getData("application/x-istari-resource");
        if (!raw) return;
        event.preventDefault();
        try {
          const parsed = JSON.parse(raw) as {
            resourceId: string;
            label: string;
            datasourceId: string;
            fields: Array<{ name: string; type: string }>;
          };
          const rect = event.currentTarget.getBoundingClientRect();
          const dropX = Math.max(8, (event.clientX - rect.left - pan.x) / zoom - 150);
          const dropY = Math.max(8, (event.clientY - rect.top - pan.y) / zoom - 40);
          onDropResource?.(parsed, { x: dropX, y: dropY });
        } catch {
          // ignore invalid drag payload
        }
      }}
      onWheel={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("[data-node-container='true']")) return;
        if (event.cancelable) event.preventDefault();
        const direction = event.deltaY > 0 ? -1 : 1;
        const step = direction > 0 ? 0.08 : -0.08;
        setZoom((prev) => Math.max(0.5, Math.min(1.9, Number((prev + step).toFixed(2)))));
      }}
    >
      <div
        className="absolute inset-0"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}
      >
        <div
          className="absolute inset-0"
          style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            if (event.target !== event.currentTarget) return;
            setIsPanning(true);
            panStartRef.current = {
              pointerX: event.clientX,
              pointerY: event.clientY,
              originX: pan.x,
              originY: pan.y,
            };
          }}
        >
          <svg className="pointer-events-none absolute inset-0 z-0 h-full w-full" aria-hidden>
        {drawableEdges.map(({ edge, sourceNode, targetNode }) => (
          <line
            key={`line-${edge.id}`}
            x1={sourceNode.position.x + 280}
            y1={sourceNode.position.y + 80}
            x2={targetNode.position.x}
            y2={targetNode.position.y + 80}
            stroke="hsl(var(--accent))"
            strokeWidth={2}
            strokeDasharray={edge.data.joinType === "inner" ? "6 4" : "0"}
            opacity={selectedEdgeId && selectedEdgeId !== edge.id ? 0.45 : 1}
          />
        ))}
        {joinSourceNodeId && cursorPosition ? (() => {
          const sourceNode = nodeById.get(joinSourceNodeId);
          if (!sourceNode) return null;
          return (
            <line
              x1={sourceNode.position.x + 300}
              y1={sourceNode.position.y + 80}
              x2={cursorPosition.x}
              y2={cursorPosition.y}
              stroke="hsl(var(--accent))"
              strokeWidth={2}
              strokeDasharray="6 4"
              opacity={0.85}
            />
          );
        })() : null}
          </svg>

          {drawableEdges.map(({ edge, sourceNode, targetNode }) => (
            <button
              key={`label-${edge.id}`}
              type="button"
              data-canvas-interactive="true"
              onClick={() => onSelectEdge?.(edge.id)}
              className={cn(
                "absolute z-30 rounded-full border border-accent/40 bg-background/65 px-2.5 py-1 text-caption font-medium uppercase tracking-wide text-accent backdrop-blur-md",
                "shadow-[0_6px_18px_hsl(var(--background)/0.5)]",
                selectedEdgeId === edge.id && "border-accent/70 bg-accent/20",
              )}
              style={{
                left: (sourceNode.position.x + 280 + targetNode.position.x) / 2 - 28,
                top: (sourceNode.position.y + 80 + targetNode.position.y + 80) / 2 - 12,
              }}
            >
              {edge.data.joinType.toUpperCase()}
            </button>
          ))}

          {nodes.map((node) => (
            <div
              key={node.id}
              data-canvas-interactive="true"
              className={cn("absolute", draggingNodeId === node.id ? "cursor-grabbing" : "cursor-grab")}
              style={{ left: node.position.x, top: node.position.y }}
              onPointerDown={(event) => {
                const rect = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
                dragDeltaRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
                setDraggingNodeId(node.id);
              }}
              onPointerMove={(event) => {
                if (draggingNodeId !== node.id || !dragDeltaRef.current) return;
                const parent = (event.currentTarget.parentElement as HTMLDivElement | null)?.getBoundingClientRect();
                if (!parent) return;
                const nextX = Math.max(8, (event.clientX - parent.left - dragDeltaRef.current.dx) / zoom);
                const nextY = Math.max(8, (event.clientY - parent.top - dragDeltaRef.current.dy) / zoom);
                onMoveNode?.(node.id, { x: nextX, y: nextY });
              }}
              onPointerUp={() => {
                setDraggingNodeId(null);
                dragDeltaRef.current = null;
              }}
            >
          <button
            type="button"
            className={cn(
              "absolute -left-2 top-[76px] z-20 h-4 w-4 rounded-full border",
              "border-accent/70 bg-background/95 shadow-sm",
            )}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              if (joinSourceNodeId && joinSourceNodeId !== node.id) {
                onCreateJoin?.(joinSourceNodeId, node.id);
                setJoinSourceNodeId(null);
                setCursorPosition(null);
                return;
              }
              setJoinSourceNodeId(node.id);
            }}
            aria-label={`Conectar para ${node.data.label}`}
          />
          <button
            type="button"
            className={cn(
              "absolute -right-2 top-[76px] z-20 h-4 w-4 rounded-full border",
              joinSourceNodeId === node.id ? "border-accent bg-accent/30" : "border-accent/70 bg-background/95",
              "shadow-sm",
            )}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              if (!joinSourceNodeId || joinSourceNodeId === node.id) {
                setJoinSourceNodeId(node.id);
                return;
              }
              onCreateJoin?.(joinSourceNodeId, node.id);
              setJoinSourceNodeId(null);
              setCursorPosition(null);
            }}
            aria-label={`Conector de saida de ${node.data.label}`}
          />
              <ResourceNode
                node={node}
                selected={selectedNodeId === node.id}
                cleanMode={!!cleanModeByNodeId[node.id]}
                relatedFields={relatedFieldsByNode.get(node.id) || new Set<string>()}
                onClick={() => onSelectNode?.(node.id)}
                onToggleCleanMode={() => {
                  setCleanModeByNodeId((prev) => ({ ...prev, [node.id]: !prev[node.id] }));
                  onToggleNodeCleanMode?.(node.id);
                }}
                onToggleField={(fieldId, selectedValue) => onToggleField?.(node.id, fieldId, selectedValue)}
              />
            </div>
          ))}
        </div>
      </div>

      {!nodes.length ? (
        <div className="flex h-full items-center justify-center">
          <Badge variant="secondary" className="border-border-strong bg-card/80">
            Adicione um recurso para iniciar o canvas
          </Badge>
        </div>
      ) : null}

      <Badge variant="outline" className="absolute right-3 top-3 bg-card/70 text-caption font-medium">
        {Math.round(zoom * 100)}%
      </Badge>
      <span className="pointer-events-none absolute left-3 top-3 text-caption text-muted-foreground">
        {isPanning ? "Panning..." : "Drag em area vazia para mover"}
      </span>
    </div>
  );
};

export default DatasetCanvasView;
