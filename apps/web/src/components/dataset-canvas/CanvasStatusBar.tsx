import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type CanvasStatusBarProps = {
  resources: number;
  joins: number;
  columns: number;
  computedColumns: number;
  metrics: number;
  dimensions: number;
  dirty: boolean;
  hasValidationError: boolean;
  lastSavedAt?: string | null;
};

const CanvasStatusBar = ({
  resources,
  joins,
  columns,
  computedColumns,
  metrics,
  dimensions,
  dirty,
  hasValidationError,
  lastSavedAt,
}: CanvasStatusBarProps) => {
  const statusLabel = hasValidationError
    ? "Erro de validacao"
    : dirty
      ? "Rascunho nao salvo"
      : "Salvo";

  const statusClass = hasValidationError
    ? "bg-destructive/10 text-destructive border-destructive/40"
    : dirty
      ? "bg-warning/10 text-warning border-warning/40"
      : "bg-success/10 text-success border-success/40";

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card/40 px-3 py-2 text-caption">
      <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
        <Badge variant="secondary">{resources} recursos</Badge>
        <Badge variant="secondary">{joins} joins</Badge>
        <Badge variant="secondary">{columns} colunas</Badge>
        <Badge variant="secondary">{computedColumns} computed</Badge>
        <Badge variant="secondary">{metrics} metricas</Badge>
        <Badge variant="secondary">{dimensions} dimensoes</Badge>
      </div>
      <div className="flex items-center gap-2">
        <span className={cn("rounded-md border px-2 py-1 font-medium", statusClass)}>{statusLabel}</span>
        {lastSavedAt ? <span className="text-muted-foreground">ultimo save: {new Date(lastSavedAt).toLocaleTimeString("pt-BR")}</span> : null}
      </div>
    </div>
  );
};

export default CanvasStatusBar;
