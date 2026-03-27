import { useMemo, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { ApiCatalogDataPreviewResponse } from "@/lib/api";
import type { DatasetCanvasEdge, DatasetCanvasNode } from "./canvas-types";

type PreviewColumn = {
  key: string;
  label: string;
  type: "text" | "numeric" | "temporal" | "boolean";
  isStatusLike: boolean;
};

type PreviewPanelProps = {
  nodes: DatasetCanvasNode[];
  edges: DatasetCanvasEdge[];
  preview: ApiCatalogDataPreviewResponse | null;
  isLoading: boolean;
  errorMessage?: string | null;
};

const normalizeLabel = (value: string): string => value.trim().toLowerCase();

const inferType = (samples: unknown[]): "text" | "numeric" | "temporal" | "boolean" => {
  const values = samples.filter((item) => item !== null && item !== undefined && item !== "");
  if (values.length === 0) return "text";
  if (values.every((item) => typeof item === "boolean")) return "boolean";
  if (values.every((item) => typeof item === "number")) return "numeric";
  if (values.every((item) => typeof item === "string" && /^-?\d+([.,]\d+)?$/.test(item.trim()))) return "numeric";
  if (values.every((item) => typeof item === "string" && !Number.isNaN(Date.parse(item)))) return "temporal";
  return "text";
};

const isStatusColumn = (columnName: string): boolean => /status|state|situacao|fase|tipo|categoria/i.test(columnName);

const statusClassName = (value: string): string => {
  const token = normalizeLabel(value);
  if (["aprovado", "approved", "active", "ativo", "success", "ok"].includes(token)) return "border-success/30 bg-success/10 text-success";
  if (["pendente", "pending", "em_analise", "processing"].includes(token)) return "border-warning/30 bg-warning/10 text-warning";
  if (["falha", "failed", "error", "erro", "reprovado", "rejected", "inactive", "inativo"].includes(token)) return "border-destructive/30 bg-destructive/10 text-destructive";
  return "border-border bg-muted/50 text-muted-foreground";
};

const formatCell = (column: PreviewColumn, value: unknown): string => {
  const isCurrency = /valor|price|preco|amount|total|custo/i.test(column.label);
  if (value === null || value === undefined || value === "") return "-";
  if (column.type === "boolean") return value ? "true" : "false";
  if (column.type === "numeric" && typeof value === "number") {
    return isCurrency
      ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value)
      : new Intl.NumberFormat("pt-BR").format(value);
  }
  if (column.type === "numeric" && typeof value === "string") {
    const numeric = Number(value.replace(",", "."));
    if (!Number.isNaN(numeric)) {
      return isCurrency
        ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(numeric)
        : new Intl.NumberFormat("pt-BR").format(numeric);
    }
  }
  if (column.type === "temporal" && typeof value === "string") {
    const timestamp = Date.parse(value);
    if (!Number.isNaN(timestamp)) return new Intl.DateTimeFormat("pt-BR").format(new Date(timestamp));
  }
  return String(value);
};

const PreviewPanel = ({ nodes, edges, preview, isLoading, errorMessage }: PreviewPanelProps) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canPreview = nodes.length > 0;
  const hasInvalidJoin = useMemo(
    () =>
      edges.some((edge) =>
        !edge.source
        || !edge.target
        || !edge.data.conditions.length
        || edge.data.conditions.some((condition) => !condition.leftColumn || !condition.rightColumn)),
    [edges],
  );

  const columns = useMemo<PreviewColumn[]>(() => {
    const fallbackColumns = preview?.rows[0] ? Object.keys(preview.rows[0]) : [];
    const source = preview?.columns?.length ? preview.columns : fallbackColumns;
    return source.map((columnName) => {
      const sampleValues = (preview?.rows || []).map((row) => row[columnName]).slice(0, 25);
      return {
        key: columnName,
        label: columnName,
        type: inferType(sampleValues),
        isStatusLike: isStatusColumn(columnName),
      };
    });
  }, [preview]);

  const rows = preview?.rows || [];
  const rowCount = preview?.row_count || 0;
  const hasPreviewData = rows.length > 0 && columns.length > 0;

  return (
    <section className="glass-panel h-full min-h-0 rounded-none border-t border-border/50">
      <div className="h-9 border-b border-border/55 px-3">
        <div className="flex h-full items-center justify-between gap-2">
          <p className="truncate text-heading">
            Preview do resultado
            <span className="ml-2 text-caption normal-case tracking-normal text-muted-foreground/80">
              {hasPreviewData ? `${rows.length.toLocaleString("pt-BR")} de ${rowCount.toLocaleString("pt-BR")} registros` : "sem dados"}
            </span>
          </p>
          <span className="hidden text-caption text-muted-foreground lg:inline">Arraste a borda para redimensionar</span>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="h-[calc(100%-36px)] min-h-0 overflow-auto"
        onWheel={(event) => {
          if (!scrollRef.current || !event.shiftKey) return;
          if (event.cancelable) event.preventDefault();
          scrollRef.current.scrollLeft += event.deltaY;
        }}
      >
        {!canPreview ? (
          <div className="flex h-full items-center justify-center px-4 text-body text-muted-foreground">
            Adicione tabelas ao canvas para visualizar o preview
          </div>
        ) : null}

        {canPreview && hasInvalidJoin ? (
          <div className="flex h-full items-center justify-center px-4 text-body text-destructive">
            Erro ao gerar preview. Verifique os joins.
          </div>
        ) : null}

        {canPreview && !hasInvalidJoin && !!errorMessage ? (
          <div className="flex h-full items-center justify-center px-4 text-body text-destructive">
            {errorMessage}
          </div>
        ) : null}

        {canPreview && !hasInvalidJoin && isLoading ? (
          <div className="space-y-1.5 p-2.5">
            {Array.from({ length: 10 }).map((_, index) => (
              <Skeleton key={`preview-skeleton-${index}`} className="h-7 w-full rounded-sm" />
            ))}
          </div>
        ) : null}

        {canPreview && !hasInvalidJoin && !isLoading && !errorMessage && !hasPreviewData ? (
          <div className="flex h-full items-center justify-center px-4 text-body text-muted-foreground">
            Ajuste o canvas que o preview sera atualizado automaticamente.
          </div>
        ) : null}

        {canPreview && !hasInvalidJoin && !isLoading && !errorMessage && hasPreviewData ? (
          <table className="min-w-full text-caption">
            <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
              <tr className="border-b border-border/55">
                {columns.map((column) => (
                  <th
                    key={`preview-head-${column.key}`}
                    className="h-8 px-3 text-left text-heading font-medium whitespace-nowrap"
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`preview-row-${rowIndex}`} className="border-b border-border/40 hover:bg-muted/20">
                  {columns.map((column) => {
                    const value = row[column.key];
                    const formatted = formatCell(column, value);
                    const numeric = column.type === "numeric";
                    const mono = numeric || /(^id$|_id$|id_)/i.test(column.label);
                    return (
                      <td
                        key={`preview-cell-${rowIndex}-${column.key}`}
                        className={[
                          "px-3 py-1.5 whitespace-nowrap text-foreground/88",
                          numeric ? "text-right" : "text-left",
                          mono ? "font-mono" : "",
                        ].join(" ").trim()}
                      >
                        {column.isStatusLike && typeof value === "string" ? (
                          <Badge variant="outline" className={statusClassName(value)}>
                            {value}
                          </Badge>
                        ) : formatted}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </section>
  );
};

export default PreviewPanel;
