import { Eye, EyeOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { DatasetCanvasNode } from "./canvas-types";

type ResourceNodeProps = {
  node: DatasetCanvasNode;
  selected?: boolean;
  cleanMode?: boolean;
  relatedFields?: Set<string>;
  onClick?: () => void;
  onToggleCleanMode?: () => void;
  onToggleField?: (fieldId: string, selected: boolean) => void;
};

const ResourceNode = ({
  node,
  selected = false,
  cleanMode = false,
  relatedFields = new Set<string>(),
  onClick,
  onToggleCleanMode,
  onToggleField,
}: ResourceNodeProps) => {
  const selectedCount = node.data.fields.filter((field) => field.selected).length;
  const sortedFields = [...node.data.fields].sort((a, b) => {
    const aIsFk = a.name.endsWith("_id");
    const bIsFk = b.name.endsWith("_id");
    if (aIsFk !== bIsFk) return aIsFk ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const visibleFields = cleanMode
    ? sortedFields.filter((field) => relatedFields.has(field.name))
    : sortedFields;

  return (
    <div
      data-node-container="true"
      onClick={onClick}
      className={cn(
        "w-[300px] cursor-pointer rounded-xl border border-border bg-card/85 text-left shadow-[0_8px_24px_hsl(var(--background)/0.45)] backdrop-blur transition-colors",
        selected && "border-accent/50 shadow-[0_0_0_1px_hsl(var(--accent)/0.22),0_10px_28px_hsl(var(--accent)/0.24)]",
      )}
    >
      <div className="mb-2 flex items-start justify-between gap-2 rounded-t-xl border-b border-border/50 bg-muted/45 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-body font-medium text-foreground">{node.data.label}</p>
          <p className="truncate font-mono text-caption text-muted-foreground">{node.data.resourceId}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className="text-caption font-medium">{selectedCount}</Badge>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleCleanMode?.();
            }}
            className={cn(
              "inline-flex h-6 w-6 items-center justify-center rounded-md border border-border/60 bg-background/60 text-muted-foreground transition-colors hover:text-foreground",
              cleanMode && "border-accent/60 text-accent",
            )}
            aria-label={cleanMode ? "Desativar modo limpo" : "Ativar modo limpo"}
            title={cleanMode ? "Modo limpo ativo" : "Modo limpo"}
          >
            {cleanMode ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      <div data-node-scroll="true" className="h-[232px] space-y-1 overflow-y-auto px-3 pb-3">
        {visibleFields.map((field) => {
          const isPk = field.name === "id";
          const isFk = field.name.endsWith("_id");
          const relatedFk = isFk && relatedFields.has(field.name);
          return (
          <div key={`${node.id}-${field.id}`} className="flex items-center gap-2 rounded-md px-1 py-1 text-caption hover:bg-muted/40">
            <Checkbox
              checked={field.selected}
              onCheckedChange={(checked) => onToggleField?.(field.id, checked === true)}
              onClick={(event) => event.stopPropagation()}
            />
            <span className="min-w-0 flex-1 truncate font-mono text-foreground/90">
              {field.alias && field.alias !== field.name ? `${field.name} -> ${field.alias}` : field.name}
            </span>
            <Badge
              variant="secondary"
              className={cn(
                "shrink-0 text-caption font-medium",
                relatedFk && "border-accent/40 bg-accent/20 text-accent",
              )}
            >
              {isPk ? "PK" : isFk ? "FK" : field.type}
            </Badge>
          </div>
          );
        })}
        {cleanMode && visibleFields.length === 0 ? (
          <p className="px-1 pt-2 text-caption text-muted-foreground">Nenhum campo em relacao neste node.</p>
        ) : null}
      </div>
    </div>
  );
};

export default ResourceNode;
