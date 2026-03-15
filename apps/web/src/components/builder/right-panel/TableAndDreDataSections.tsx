import { useMemo, type DragEvent, type ElementType } from "react";
import { Copy, GripVertical, List, MoreHorizontal, Plus, Sigma, TrendingDown, TrendingUp, Trash2, X } from "lucide-react";

import type { DashboardWidget, MetricOp, TableColumnAggregation } from "@/types/dashboard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { SentenceTokenSelectProps } from "@/components/builder/right-panel/shared";
import { cn } from "@/lib/utils";

type ColumnType = "numeric" | "temporal" | "text" | "boolean";
type ColumnDef = { name: string; type: string };
type FormatOption = { value: string; label: string };
type TableColumnDraft = {
  id: string;
  source: string;
  label?: string;
  aggregation?: TableColumnAggregation;
  format?: string;
  prefix?: string;
  suffix?: string;
};
type DreRowType = "result" | "deduction" | "detail";
type DreRow = {
  title: string;
  row_type: DreRowType;
  impact?: "add" | "subtract";
  metrics: Array<{ op: MetricOp; column?: string }>;
};
type MetricMode = "atomic" | "composite" | "derived";
type TokenSelectComponent = (props: SentenceTokenSelectProps) => JSX.Element;
type KpiDependencyDraft = { source_type: "widget" | "column"; widget_id?: number | string; column?: string; alias: string };

type TableWidgetDataSectionProps = {
  allTableColumnsSelected: boolean;
  setConfig: (patch: Partial<DashboardWidget["config"]>) => void;
  selectedTableColumnDefs: TableColumnDraft[];
  resolvedColumns: ColumnDef[];
  buildTableColumnInstanceId: (source: string) => string;
  getDefaultTableColumnFormat: (columnName: string) => string;
  setTableColumnInstances: (instances: TableColumnDraft[]) => void;
  tableDropZone: "selected" | "available" | null;
  draggedTableColumn: string | null;
  tableDropColumn: string | null;
  setTableDropZone: (zone: "selected" | "available" | null) => void;
  setTableDropColumn: (columnId: string | null) => void;
  moveTableColumn: (payload: string, destination: "selected" | "available", targetInstanceId?: string) => void;
  resetTableDragState: () => void;
  getColumnType: (name: string) => ColumnType;
  updateTableColumnInstance: (instanceId: string, patch: Partial<Pick<TableColumnDraft, "label" | "aggregation" | "format" | "prefix" | "suffix">>) => void;
  openTableColumnMenu: string | null;
  setOpenTableColumnMenu: (id: string | null) => void;
  getTableFormatOptions: (columnName: string) => FormatOption[];
  duplicateTableColumn: (instanceId: string) => void;
  removeTableColumn: (instanceId: string) => void;
  handleTableDragStart: (event: DragEvent<HTMLButtonElement>, payload: string) => void;
  availableTableColumnDefs: ColumnDef[];
  addTableColumn: (source: string, insertBeforeInstanceId?: string, template?: Partial<Pick<TableColumnDraft, "label" | "aggregation" | "format" | "prefix" | "suffix">>) => void;
  draft: DashboardWidget;
  columnTypeBadgeMeta: Record<ColumnType, { label: string; icon: ElementType; className: string }>;
};

type DreWidgetDataSectionProps = {
  numericColumns: ColumnDef[];
  updateDreRows: (updater: (rows: DreRow[]) => DreRow[]) => void;
  createDefaultDreRow: (rowType?: DreRowType, sourceRow?: DreRow) => DreRow;
  dreRowsForUi: DreRow[];
  setConfig: (patch: Partial<DashboardWidget["config"]>) => void;
  drePercentBaseRowIndex?: number;
  draggedDreRowIndex: number | null;
  dreDropRowIndex: number | null;
  setDreDropRowIndex: (index: number | null) => void;
  moveDreRow: (fromIndex: number, targetIndex: number) => void;
  setDraggedDreRowIndex: (index: number | null) => void;
  openDreRowMenu: string | null;
  setOpenDreRowMenu: (value: string | null) => void;
};

type DonutWidgetDataSectionProps = {
  metricOps: MetricOp[];
  metricLabelByOp: Record<MetricOp, string>;
  numericColumns: ColumnDef[];
  SentenceTokenSelect: TokenSelectComponent;
  donutSentenceAgg: string;
  setDonutSentenceAgg: (value: string) => void;
  donutSentenceColumn: string;
  setDonutSentenceColumn: (value: string) => void;
  donutSentenceColumnOptions: Array<{ value: string; label: string; disabled?: boolean }>;
  donutDimensionValue: string;
  setConfig: (patch: Partial<DashboardWidget["config"]>) => void;
  categoricalColumns: ColumnDef[];
  temporalColumns: ColumnDef[];
  donutSentencePreview: string;
};

type BarLikeWidgetDataSectionProps = {
  SentenceTokenSelect: TokenSelectComponent;
  barSentenceAgg: string;
  setBarSentenceAgg: (value: string) => void;
  metricOps: MetricOp[];
  metricLabelByOp: Record<MetricOp, string>;
  numericColumns: ColumnDef[];
  barSentenceColumn: string;
  setBarSentenceColumn: (value: string) => void;
  barSentenceColumnOptions: Array<{ value: string; label: string; disabled?: boolean }>;
  barLikeDimensionIsTemporal: boolean;
  barLikeDimensionColumn: string;
  setConfig: (patch: Partial<DashboardWidget["config"]>) => void;
  temporalColumns: ColumnDef[];
  categoricalColumns: ColumnDef[];
  buildTemporalDimensionToken: (column: string, granularity: "day" | "month" | "week" | "weekday" | "hour") => string;
  draft: DashboardWidget;
  barLikeDimensionGranularity: string;
  temporalDimensionGranularityOptions: Array<{ value: "day" | "month" | "week" | "weekday" | "hour"; label: string }>;
  barSentencePreview: string;
  barLikeDimensionPreview: string;
};

type GenericMetricDataSectionProps = {
  metric: { op: MetricOp; column?: string };
  setMetric: (patch: Partial<{ op: MetricOp; column?: string }>) => void;
  metricOps: MetricOp[];
  countLikeOps: Set<MetricOp>;
  resolvedColumns: ColumnDef[];
  numericColumns: ColumnDef[];
};

type KpiWidgetDataSectionProps = {
  kpiMode: MetricMode;
  handleKpiModeChange: (value: string) => void;
  kpiModeOptions: Array<{ value: MetricMode; title: string; description: string }>;
  isCompositeSentence: boolean;
  SentenceTokenSelect: TokenSelectComponent;
  kpiSentenceFinalAgg: MetricOp;
  setKpiSentenceFinalAgg: (value: string) => void;
  kpiFinalAggOptions: Array<{ value: MetricOp; label: string }>;
  kpiSentenceBaseAgg: MetricOp;
  setKpiSentenceBaseAgg: (value: string) => void;
  kpiBaseAggOptions: Array<{ value: MetricOp; label: string }>;
  numericColumns: ColumnDef[];
  countLikeOps: Set<MetricOp>;
  kpiSentenceColumn: string;
  setKpiSentenceColumn: (value: string) => void;
  kpiAllowedColumns: ColumnDef[];
  kpiTimeTokenValue: string;
  setKpiSentenceTimeToken: (value: string) => void;
  kpiTimeTokenOptions: Array<{ value: string; label: string; disabled?: boolean }>;
  kpiSentencePreview: string;
  normalizedDerivedDeps: KpiDependencyDraft[];
  draft: DashboardWidget;
  setConfig: (patch: Partial<DashboardWidget["config"]>) => void;
  resolvedColumns: ColumnDef[];
  normalizeKpiDependencyWidgetId: (value: unknown) => number | string | undefined;
  availableDashboardKpiWidgets: DashboardWidget[];
  createDefaultKpiDependency: (index: number) => KpiDependencyDraft;
  derivedMetricAliases: string[];
  extractKpiFormulaRefs: (formula: string) => string[];
};

export const TableWidgetDataSection = (props: TableWidgetDataSectionProps) => {
  const {
    allTableColumnsSelected,
    setConfig,
    selectedTableColumnDefs,
    resolvedColumns,
    buildTableColumnInstanceId,
    getDefaultTableColumnFormat,
    setTableColumnInstances,
    tableDropZone,
    draggedTableColumn,
    tableDropColumn,
    setTableDropZone,
    setTableDropColumn,
    moveTableColumn,
    resetTableDragState,
    getColumnType,
    updateTableColumnInstance,
    openTableColumnMenu,
    setOpenTableColumnMenu,
    getTableFormatOptions,
    duplicateTableColumn,
    removeTableColumn,
    handleTableDragStart,
    availableTableColumnDefs,
    addTableColumn,
    draft,
    columnTypeBadgeMeta,
  } = props;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={allTableColumnsSelected}
            onCheckedChange={(checked) => {
              if (checked !== true) {
                setConfig({
                  columns: [],
                  table_column_instances: [],
                  table_column_labels: {},
                  table_column_aggs: {},
                  table_column_formats: {},
                  table_column_prefixes: {},
                  table_column_suffixes: {},
                });
                return;
              }
              const current = draft.config.columns || [];
              const missing = resolvedColumns.map((column) => column.name).filter((name: string) => !current.includes(name));
              const existingBySource = new Set(selectedTableColumnDefs.map((item) => item.source));
              const appended = missing.map((source: string) => ({
                id: buildTableColumnInstanceId(source),
                source,
                aggregation: "none" as TableColumnAggregation,
                format: getDefaultTableColumnFormat(source),
              }));
              const baseInstances = selectedTableColumnDefs.filter((item) => existingBySource.has(item.source));
              setTableColumnInstances([...baseInstances, ...appended]);
            }}
          />
          Selecionar todas
        </label>
      </div>
      <div className="grid grid-cols-1 gap-2">
        <div
          className={cn(
            "rounded-md border border-border/70 p-1",
            tableDropZone === "selected" && "border-dashed border-accent/60 bg-accent/5",
          )}
          onDragOver={(event) => {
            if (!draggedTableColumn) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setTableDropZone("selected");
            setTableDropColumn(null);
          }}
          onDragLeave={() => {
            if (tableDropZone === "selected" && !tableDropColumn) setTableDropZone(null);
          }}
          onDrop={(event) => {
            if (!draggedTableColumn) return;
            event.preventDefault();
            moveTableColumn(draggedTableColumn, "selected");
            resetTableDragState();
          }}
        >
          <div className="flex items-center justify-between px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span>Selecionadas ({selectedTableColumnDefs.length})</span>
          </div>
          <div className="max-h-64 space-y-0.5 overflow-auto">
            {selectedTableColumnDefs.map((item) => {
              const inferredFormat = item.format || getDefaultTableColumnFormat(item.source);
              const formatValue = item.format || inferredFormat;
              const columnType = getColumnType(item.source);
              const renamedValue = item.label || "";
              const showOriginalName = renamedValue.trim() && renamedValue.trim() !== item.source;
              return (
                <div
                  key={item.id}
                  className={cn(
                    "relative grid grid-cols-[auto_auto_auto_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md border border-border/60 px-1.5 py-1 transition-colors bg-background/60",
                    draggedTableColumn === `instance:${item.id}` && "opacity-45 border-dashed scale-[0.99]",
                    tableDropZone === "selected" && tableDropColumn === item.id && "border-accent/70 bg-accent/10 ring-2 ring-accent/55",
                  )}
                  onDragOver={(event) => {
                    if (!draggedTableColumn) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setTableDropZone("selected");
                    setTableDropColumn(item.id);
                  }}
                  onDrop={(event) => {
                    if (!draggedTableColumn) return;
                    event.preventDefault();
                    moveTableColumn(draggedTableColumn, "selected", item.id);
                    resetTableDragState();
                  }}
                >
                  {tableDropZone === "selected" && tableDropColumn === item.id && (
                    <span className="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded-full bg-accent/90" />
                  )}
                  <Checkbox checked onCheckedChange={(value) => { if (value !== true) removeTableColumn(item.id); }} />
                  <button
                    type="button"
                    className="flex h-5 w-5 cursor-grab items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60"
                    draggable
                    onDragStart={(event: DragEvent<HTMLButtonElement>) => handleTableDragStart(event, `instance:${item.id}`)}
                    onDragEnd={resetTableDragState}
                    aria-label={`Reordenar coluna ${item.source}`}
                  >
                    <span className="text-xs leading-none">{"\u2630"}</span>
                  </button>
                  <Badge variant="outline" className={cn("h-5 min-w-8 justify-center gap-1 px-1.5 text-[10px] font-medium", columnTypeBadgeMeta[columnType].className)}>
                    {(() => {
                      const TypeIcon = columnTypeBadgeMeta[columnType].icon;
                      return <TypeIcon className="h-3 w-3" />;
                    })()}
                    <span className="leading-none">{columnTypeBadgeMeta[columnType].label}</span>
                  </Badge>
                  <div className="min-w-0">
                    <Input
                      data-column-rename-input="true"
                      className="h-6 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
                      value={renamedValue}
                      placeholder={item.source}
                      onChange={(event) => updateTableColumnInstance(item.id, { label: event.target.value })}
                    />
                    {showOriginalName && (
                      <p className="truncate px-0 text-[10px] font-normal text-muted-foreground/70">{item.source}</p>
                    )}
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    <DropdownMenu
                      open={openTableColumnMenu === item.id}
                      onOpenChange={(open) => setOpenTableColumnMenu(open ? item.id : null)}
                    >
                      <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" size="icon" className="h-6 w-6">
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        <div className="flex items-center justify-between px-2 pb-1">
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Configurações</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => setOpenTableColumnMenu(null)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        <DropdownMenuLabel className="space-y-0.5">
                          <p className="truncate text-xs font-semibold">{renamedValue.trim() || item.source}</p>
                          <p className="truncate text-[10px] font-normal text-muted-foreground/70">{item.source}</p>
                        </DropdownMenuLabel>
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>Formatação</DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            {getTableFormatOptions(item.source).map((option) => (
                              <DropdownMenuItem
                                key={`${item.id}-format-${option.value}`}
                                className={cn(formatValue === option.value && "bg-accent/60")}
                                onClick={() => updateTableColumnInstance(item.id, { format: option.value })}
                              >
                                {option.label}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuItem onClick={() => duplicateTableColumn(item.id)}>
                          Duplicar coluna
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <div className="space-y-1.5 px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                          <Label className="text-[10px] text-muted-foreground">Prefixo</Label>
                          <Input
                            className="h-7 text-xs"
                            value={item.prefix || ""}
                            placeholder="Ex: R$ "
                            onChange={(event) => updateTableColumnInstance(item.id, { prefix: event.target.value })}
                          />
                          <Label className="text-[10px] text-muted-foreground">Sufixo</Label>
                          <Input
                            className="h-7 text-xs"
                            value={item.suffix || ""}
                            placeholder="Ex: %"
                            onChange={(event) => updateTableColumnInstance(item.id, { suffix: event.target.value })}
                          />
                        </div>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => setOpenTableColumnMenu(null)}>
                          Salvar
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              );
            })}
            {selectedTableColumnDefs.length === 0 && (
              <div className="rounded-md border border-dashed border-border/70 px-2 py-3 text-center text-[11px] text-muted-foreground">
                Arraste colunas da lista ao lado para adicionar.
              </div>
            )}
          </div>
        </div>
        <div
          className={cn(
            "rounded-md border border-border/70 p-1",
            tableDropZone === "available" && "border-dashed border-accent/60 bg-accent/5",
          )}
          onDragOver={(event) => {
            if (!draggedTableColumn) return;
            event.preventDefault();
            setTableDropZone("available");
            setTableDropColumn(null);
          }}
          onDragLeave={() => {
            if (tableDropZone === "available" && !tableDropColumn) setTableDropZone(null);
          }}
          onDrop={(event) => {
            if (!draggedTableColumn) return;
            event.preventDefault();
            moveTableColumn(draggedTableColumn, "available");
            resetTableDragState();
          }}
        >
          <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Disponiveis ({availableTableColumnDefs.length})
          </div>
          <div className="max-h-64 space-y-0.5 overflow-auto">
            {availableTableColumnDefs.map((column) => {
              const columnType = getColumnType(column.name);
              return (
                <div
                  key={column.name}
                  className={cn(
                    "grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md border border-border/50 bg-background/30 px-1.5 py-1 transition-colors",
                    draggedTableColumn === `source:${column.name}` && "opacity-55 border-dashed",
                    tableDropZone === "available" && tableDropColumn === column.name && "ring-1 ring-accent/60 bg-accent/10",
                  )}
                  onDragOver={(event) => {
                    if (!draggedTableColumn) return;
                    event.preventDefault();
                    setTableDropZone("available");
                    setTableDropColumn(column.name);
                  }}
                >
                  <button
                    type="button"
                    className="flex h-5 w-5 cursor-grab items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60"
                    draggable
                    onDragStart={(event: DragEvent<HTMLButtonElement>) => handleTableDragStart(event, `source:${column.name}`)}
                    onDragEnd={resetTableDragState}
                    aria-label={`Mover coluna ${column.name}`}
                  >
                    <span className="text-xs leading-none">{"\u2630"}</span>
                  </button>
                  <Badge variant="outline" className={cn("h-5 min-w-8 justify-center gap-1 px-1.5 text-[10px] font-medium", columnTypeBadgeMeta[columnType].className)}>
                    {(() => {
                      const TypeIcon = columnTypeBadgeMeta[columnType].icon;
                      return <TypeIcon className="h-3 w-3" />;
                    })()}
                    <span className="leading-none">{columnTypeBadgeMeta[columnType].label}</span>
                  </Badge>
                  <p className="truncate text-xs text-muted-foreground">{column.name}</p>
                  <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={() => addTableColumn(column.name)}>
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
            {availableTableColumnDefs.length === 0 && (
              <div className="rounded-md border border-dashed border-border/70 px-2 py-3 text-center text-[11px] text-muted-foreground">
                Todas as colunas ja foram selecionadas.
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2">
        <Label className="text-caption text-muted-foreground">Itens por página</Label>
        <Select
          value={String(draft.config.table_page_size || 25)}
          onValueChange={(value) => setConfig({ table_page_size: Math.max(1, Number(value) || 25) })}
        >
          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="10">10</SelectItem>
            <SelectItem value="25">25</SelectItem>
            <SelectItem value="50">50</SelectItem>
            <SelectItem value="100">100</SelectItem>
            <SelectItem value="200">200</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
};

export const DreWidgetDataSection = (props: DreWidgetDataSectionProps) => {
  const {
    numericColumns,
    updateDreRows,
    createDefaultDreRow,
    dreRowsForUi,
    setConfig,
    drePercentBaseRowIndex,
    draggedDreRowIndex,
    dreDropRowIndex,
    setDreDropRowIndex,
    moveDreRow,
    setDraggedDreRowIndex,
    openDreRowMenu,
    setOpenDreRowMenu,
  } = props;

  type DreAccountKind = "total" | "receita" | "custo" | "detalhe";
  const accountKindMeta = useMemo<Record<DreAccountKind, {
    label: string;
    menuLabel: string;
    menuIcon: ElementType;
    rowType: DreRowType;
    impact?: "add" | "subtract";
    rowClass: string;
    badgeClass: string;
    signClass: string;
  }>>(() => ({
    total: {
      label: "Total",
      menuLabel: "Total",
      menuIcon: Sigma,
      rowType: "result",
      impact: "add",
      rowClass: "border-violet-500/45 bg-violet-500/10",
      badgeClass: "border-violet-500/40 bg-violet-500/15 text-violet-200",
      signClass: "text-violet-300",
    },
    receita: {
      label: "Receita",
      menuLabel: "Receita",
      menuIcon: TrendingUp,
      rowType: "deduction",
      impact: "add",
      rowClass: "border-emerald-500/45 bg-emerald-500/10",
      badgeClass: "border-emerald-500/40 bg-emerald-500/15 text-emerald-200",
      signClass: "text-emerald-300",
    },
    custo: {
      label: "Custo",
      menuLabel: "Custo",
      menuIcon: TrendingDown,
      rowType: "deduction",
      impact: "subtract",
      rowClass: "border-rose-500/45 bg-rose-500/10",
      badgeClass: "border-rose-500/40 bg-rose-500/15 text-rose-200",
      signClass: "text-rose-300",
    },
    detalhe: {
      label: "Detalhe",
      menuLabel: "Detalhe",
      menuIcon: List,
      rowType: "detail",
      rowClass: "border-border/60 bg-background/55",
      badgeClass: "border-border/60 bg-muted/35 text-muted-foreground",
      signClass: "text-muted-foreground",
    },
  }), []);

  const getRowKind = (row: DreRow): DreAccountKind => {
    if (row.row_type === "result") return "total";
    if (row.row_type === "detail") return "detalhe";
    return row.impact === "add" ? "receita" : "custo";
  };

  const addRowByKind = (kind: DreAccountKind) => {
    const rowTemplate = accountKindMeta[kind];
    updateDreRows((rows: DreRow[]) => [
      ...rows,
      {
        ...createDefaultDreRow(rowTemplate.rowType),
        title: rowTemplate.label,
        impact: rowTemplate.impact,
      },
    ]);
  };
  const duplicateRowAt = (index: number) =>
    updateDreRows((rows: DreRow[]) => {
      const next = [...rows];
      const currentRow = rows[index];
      if (!currentRow) return rows;
      next.splice(index + 1, 0, createDefaultDreRow(currentRow.row_type, currentRow));
      return next;
    });
  const removeRowAt = (index: number) =>
    updateDreRows((rows: DreRow[]) => rows.filter((_, rowIndex) => rowIndex !== index));

  return (
    <div className="space-y-2">
      {numericColumns.length === 0 && (
        <div className="rounded-md border border-amber-400/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-100">
          Nenhuma coluna numérica encontrada. Selecione uma view com campos numéricos para o DRE.
        </div>
      )}

      <div className="space-y-2">
        {dreRowsForUi.length === 0 && (
          <div className="rounded-md border border-dashed border-border/70 bg-background/40 px-3 py-2 text-xs text-muted-foreground">
            Nenhuma conta adicionada.
          </div>
        )}
        {dreRowsForUi.map((row, index: number) => {
          const rowKind = getRowKind(row);
          const rowKindMeta = accountKindMeta[rowKind];
          const rowMetrics = row.metrics && row.metrics.length > 0
            ? row.metrics
            : [{ op: "sum" as const, column: numericColumns[0]?.name }];
          const rowSign = rowKind === "receita" ? "+" : rowKind === "custo" ? "-" : null;
          const detailIndentClass = row.row_type === "detail" ? "ml-5" : "";
          return (
            <div
              key={`dre-row-${index}`}
              className={cn(
                "relative space-y-1.5 rounded-md border p-2 transition-colors",
                rowKindMeta.rowClass,
                detailIndentClass,
                draggedDreRowIndex === index && "opacity-45 border-dashed",
                dreDropRowIndex === index && "ring-2 ring-accent/50 border-accent/70 bg-accent/10",
              )}
              onDragOver={(event) => {
                if (draggedDreRowIndex === null) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDreDropRowIndex(index);
              }}
              onDrop={(event) => {
                if (draggedDreRowIndex === null) return;
                event.preventDefault();
                moveDreRow(draggedDreRowIndex, index);
                setDraggedDreRowIndex(null);
                setDreDropRowIndex(null);
              }}
            >
              {dreDropRowIndex === index && (
                <span className="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded-full bg-accent/90" />
              )}
              <div className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto_auto] items-center gap-1.5">
                <button
                  type="button"
                  className="flex h-7 w-7 cursor-grab items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60"
                  draggable
                  onDragStart={(event: DragEvent<HTMLButtonElement>) => {
                    event.dataTransfer.effectAllowed = "move";
                    setDraggedDreRowIndex(index);
                    setDreDropRowIndex(index);
                  }}
                  onDragEnd={() => {
                    setDraggedDreRowIndex(null);
                    setDreDropRowIndex(null);
                  }}
                  aria-label={`Mover linha DRE ${index + 1}`}
                >
                  <GripVertical className="h-3.5 w-3.5" />
                </button>
                <span className={cn("inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-[10px] font-semibold uppercase tracking-wide", rowKindMeta.badgeClass)}>
                  <span>{rowKindMeta.label}</span>
                </span>
                <div className="flex min-w-0 items-center gap-1.5">
                  {rowSign && <span className={cn("inline-flex w-4 justify-center text-sm font-semibold", rowKindMeta.signClass)}>{rowSign}</span>}
                  <Input
                    data-dre-row-title-input="true"
                    className="h-8 text-xs"
                    value={row.title}
                    placeholder="Nome da conta"
                    onChange={(event) => {
                      updateDreRows((rows: DreRow[]) => {
                        const next = [...rows];
                        const currentRow = rows[index] || row;
                        next[index] = { ...currentRow, title: event.target.value };
                        return next;
                      });
                    }}
                  />
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={() => duplicateRowAt(index)}
                  aria-label={`Duplicar linha DRE ${index + 1}`}
                >
                  <Copy className="h-3 w-3" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={() => removeRowAt(index)}
                  aria-label={`Excluir linha DRE ${index + 1}`}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
                <DropdownMenu open={openDreRowMenu === `${index}`} onOpenChange={(open) => setOpenDreRowMenu(open ? `${index}` : null)}>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground">
                      <MoreHorizontal className="h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    <DropdownMenuLabel>Ações</DropdownMenuLabel>
                    <DropdownMenuItem onSelect={() => setOpenDreRowMenu(null)}>
                      Editar nome
                    </DropdownMenuItem>
                    {row.row_type === "result" && (
                      <DropdownMenuItem
                        disabled={drePercentBaseRowIndex === index}
                        onSelect={() => setConfig({ dre_percent_base_row_index: index })}
                      >
                        {drePercentBaseRowIndex === index ? "Base do % (ativa)" : "Marcar como base do %"}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      onSelect={() => duplicateRowAt(index)}
                    >
                      Duplicar
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() => removeRowAt(index)}
                    >
                      Excluir
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <div className={cn("space-y-1", row.row_type === "detail" && "pl-1")}>
                {rowMetrics.map((metricItem, metricIndex) => (
                  <div
                    key={`dre-row-${index}-metric-${metricIndex}`}
                    className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <span className="text-[11px] font-medium">{"SOMA de"}</span>
                    <div className="min-w-0">
                      <Select
                        value={metricItem.column || "__none__"}
                        onValueChange={(value) =>
                          updateDreRows((rows: DreRow[]) => {
                            const next = [...rows];
                            const currentRow = rows[index] || row;
                            const sourceMetrics = currentRow.metrics && currentRow.metrics.length > 0 ? [...currentRow.metrics] : [...rowMetrics];
                            sourceMetrics[metricIndex] = { ...sourceMetrics[metricIndex], op: "sum", column: value === "__none__" ? undefined : value };
                            next[index] = { ...currentRow, metrics: sourceMetrics };
                            return next;
                          })}
                      >
                        <SelectTrigger className="h-7 w-full text-xs"><SelectValue placeholder="coluna numérica" /></SelectTrigger>
                        <SelectContent>
                          {numericColumns.length === 0 && <SelectItem value="__none__">Sem coluna numérica</SelectItem>}
                          {numericColumns.map((column) => (
                            <SelectItem key={`dre-col-${index}-${metricIndex}-${column.name}`} value={column.name}>{column.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className={cn(
                        "h-6 w-6 text-muted-foreground hover:text-foreground",
                        metricIndex !== rowMetrics.length - 1 && "invisible pointer-events-none",
                      )}
                      onClick={() => {
                        updateDreRows((rows: DreRow[]) => {
                          const next = [...rows];
                          const currentRow = rows[index] || row;
                          const sourceMetrics = currentRow.metrics && currentRow.metrics.length > 0 ? [...currentRow.metrics] : [...rowMetrics];
                          sourceMetrics.push({ op: "sum" as const, column: numericColumns[0]?.name });
                          next[index] = { ...currentRow, metrics: sourceMetrics };
                          return next;
                        });
                      }}
                      aria-label={`Adicionar soma na linha DRE ${index + 1}`}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className={cn(
                        "h-6 w-6 text-muted-foreground hover:text-destructive",
                        rowMetrics.length <= 1 && "invisible pointer-events-none",
                      )}
                      onClick={() => {
                        updateDreRows((rows: DreRow[]) => {
                          const next = [...rows];
                          const currentRow = rows[index] || row;
                          const sourceMetrics = currentRow.metrics && currentRow.metrics.length > 0 ? [...currentRow.metrics] : [...rowMetrics];
                          next[index] = { ...currentRow, metrics: sourceMetrics.filter((_, sourceIndex) => sourceIndex !== metricIndex) };
                          return next;
                        });
                      }}
                      aria-label={`Remover soma ${metricIndex + 1} da linha DRE ${index + 1}`}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" className="h-9 w-full border-dashed text-xs">
              <Plus className="mr-1 h-3 w-3" />
              Adicionar conta
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            <DropdownMenuLabel>Tipo da conta</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {(["total", "receita", "custo", "detalhe"] as const).map((kind) => {
              const kindMeta = accountKindMeta[kind];
              const KindIcon = kindMeta.menuIcon;
              return (
                <DropdownMenuItem key={`dre-kind-${kind}`} onSelect={() => addRowByKind(kind)}>
                  <KindIcon className="mr-2 h-3.5 w-3.5" />
                  {kindMeta.menuLabel}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
};
export const DonutWidgetDataSection = (props: DonutWidgetDataSectionProps) => {
  const {
    metricOps,
    metricLabelByOp,
    numericColumns,
    SentenceTokenSelect,
    donutSentenceAgg,
    setDonutSentenceAgg,
    donutSentenceColumn,
    setDonutSentenceColumn,
    donutSentenceColumnOptions,
    donutDimensionValue,
    setConfig,
    categoricalColumns,
    temporalColumns,
    donutSentencePreview,
  } = props;
  return (
    <div className="space-y-2">
      <Label className="text-caption text-muted-foreground">Cálculo</Label>
      <div className="rounded-lg border border-border/60 bg-background/70 p-2.5">
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <SentenceTokenSelect
            tone="agg"
            value={donutSentenceAgg}
            onChange={setDonutSentenceAgg}
            options={metricOps.map((op) => ({
              value: op,
              label: metricLabelByOp[op] || op,
              disabled: (op === "sum" || op === "avg" || op === "min" || op === "max") && numericColumns.length === 0,
            }))}
          />
          <span>de</span>
          <SentenceTokenSelect
            tone="column"
            value={donutSentenceColumn}
            onChange={setDonutSentenceColumn}
            options={donutSentenceColumnOptions.length > 0
              ? donutSentenceColumnOptions
              : [{ value: "__none__", label: "sem coluna disponível", disabled: true }]}
          />
          <span>por</span>
          <SentenceTokenSelect
            tone="segment"
            value={donutDimensionValue}
            onChange={(value: string) => setConfig({ dimensions: value === "__none__" ? [] : [value] })}
            options={[
              { value: "__none__", label: "sem dimensão" },
              ...categoricalColumns.map((column) => ({ value: column.name, label: column.name })),
              ...temporalColumns.map((column) => ({ value: column.name, label: column.name })),
            ]}
            placeholder="dimensão"
          />
        </div>
      </div>
      <p className="text-caption text-muted-foreground">Preview: {donutSentencePreview}</p>
    </div>
  );
};

export const BarLikeWidgetDataSection = (props: BarLikeWidgetDataSectionProps) => {
  const {
    SentenceTokenSelect,
    barSentenceAgg,
    setBarSentenceAgg,
    metricOps,
    metricLabelByOp,
    numericColumns,
    barSentenceColumn,
    setBarSentenceColumn,
    barSentenceColumnOptions,
    barLikeDimensionIsTemporal,
    barLikeDimensionColumn,
    setConfig,
    temporalColumns,
    categoricalColumns,
    buildTemporalDimensionToken,
    draft,
    barLikeDimensionGranularity,
    temporalDimensionGranularityOptions,
    barSentencePreview,
    barLikeDimensionPreview,
  } = props;
  return (
    <div className="space-y-2">
      <Label className="text-caption text-muted-foreground">Cálculo</Label>
      <div className="rounded-lg border border-border/60 bg-background/70 p-2.5">
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <SentenceTokenSelect
            tone="agg"
            value={barSentenceAgg}
            onChange={setBarSentenceAgg}
            options={metricOps.map((op) => ({
              value: op,
              label: metricLabelByOp[op] || op,
              disabled: (op === "sum" || op === "avg" || op === "min" || op === "max") && numericColumns.length === 0,
            }))}
          />
          <span>de</span>
          <SentenceTokenSelect
            tone="column"
            value={barSentenceColumn}
            onChange={setBarSentenceColumn}
            options={barSentenceColumnOptions.length > 0
              ? barSentenceColumnOptions
              : [{ value: "__none__", label: "sem coluna disponível", disabled: true }]}
          />
          <span>por</span>
          <SentenceTokenSelect
            tone={barLikeDimensionIsTemporal ? "time" : "column"}
            value={barLikeDimensionColumn || "__none__"}
            onChange={(value: string) => {
              if (value === "__none__") {
                setConfig({ dimensions: [] });
                return;
              }
              const isTemporal = temporalColumns.some((column) => column.name === value);
              const nextDimension = isTemporal ? buildTemporalDimensionToken(value, "day") : value;
              if (draft.config.widget_type === "column") {
                setConfig({
                  dimensions: [nextDimension],
                  order_by: [{ column: nextDimension, direction: "asc" }],
                });
                return;
              }
              setConfig({ dimensions: [nextDimension] });
            }}
            options={[
              { value: "__none__", label: "sem dimensão" },
              ...categoricalColumns.map((column) => ({ value: column.name, label: column.name })),
              ...temporalColumns.map((column) => ({ value: column.name, label: column.name })),
            ]}
            placeholder="dimensão"
            showCalendarIcon={barLikeDimensionIsTemporal}
          />
          {barLikeDimensionIsTemporal && (
            <>
              <span>como</span>
              <SentenceTokenSelect
                tone="time"
                value={barLikeDimensionGranularity}
                onChange={(value: string) => {
                  if (!barLikeDimensionColumn) return;
                  const nextDimension = buildTemporalDimensionToken(
                    barLikeDimensionColumn,
                    value as "day" | "month" | "week" | "weekday" | "hour",
                  );
                  if (draft.config.widget_type === "column") {
                    setConfig({
                      dimensions: [nextDimension],
                      order_by: [{ column: nextDimension, direction: "asc" }],
                    });
                    return;
                  }
                  setConfig({ dimensions: [nextDimension] });
                }}
                options={temporalDimensionGranularityOptions.map((option) => ({ value: option.value, label: option.label.toLowerCase() }))}
              />
            </>
          )}
        </div>
      </div>
      <p className="text-caption text-muted-foreground">Preview: {barSentencePreview} por {barLikeDimensionPreview}</p>
    </div>
  );
};

export const GenericMetricDataSection = (props: GenericMetricDataSectionProps) => {
  const { metric, setMetric, metricOps, countLikeOps, resolvedColumns, numericColumns } = props;
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2">
      <Select value={metric.op} onValueChange={(value) => setMetric({ op: value as MetricOp })}>
        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>{metricOps.map((op) => <SelectItem key={op} value={op}>{op}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={metric.column || "__none__"} onValueChange={(value) => setMetric({ column: value === "__none__" ? undefined : value })}>
        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Coluna" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">Sem coluna</SelectItem>
          {(countLikeOps.has(metric.op) ? resolvedColumns : numericColumns).map((column) => (
            <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

export const KpiWidgetDataSection = (props: KpiWidgetDataSectionProps) => {
  const {
    kpiMode,
    handleKpiModeChange,
    kpiModeOptions,
    isCompositeSentence,
    SentenceTokenSelect,
    kpiSentenceFinalAgg,
    setKpiSentenceFinalAgg,
    kpiFinalAggOptions,
    kpiSentenceBaseAgg,
    setKpiSentenceBaseAgg,
    kpiBaseAggOptions,
    numericColumns,
    countLikeOps,
    kpiSentenceColumn,
    setKpiSentenceColumn,
    kpiAllowedColumns,
    kpiTimeTokenValue,
    setKpiSentenceTimeToken,
    kpiTimeTokenOptions,
    kpiSentencePreview,
    normalizedDerivedDeps,
    draft,
    setConfig,
    resolvedColumns,
    normalizeKpiDependencyWidgetId,
    availableDashboardKpiWidgets,
    createDefaultKpiDependency,
    derivedMetricAliases,
    extractKpiFormulaRefs,
  } = props;

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-caption text-muted-foreground">Tipo de Métrica</Label>
        <div className="space-y-2">
          <Select value={kpiMode} onValueChange={handleKpiModeChange}>
            <SelectTrigger className="h-auto min-h-[64px] cursor-pointer rounded-lg border-accent/50 bg-accent/10 px-3 py-2 text-left hover:border-accent/70 hover:bg-accent/15">
              {(() => {
                const current = kpiModeOptions.find((option) => option.value === kpiMode) || kpiModeOptions[0];
                return (
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-violet-100">{current.title}</p>
                    <p className="mt-0.5 whitespace-normal text-[11px] leading-4 text-slate-200">{current.description}</p>
                  </div>
                );
              })()}
            </SelectTrigger>
            <SelectContent>
              {kpiModeOptions.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  className="group h-auto cursor-pointer rounded-md py-2 data-[state=checked]:bg-accent data-[state=checked]:text-white"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-foreground group-data-[state=checked]:text-white">{option.title}</p>
                    <p className="mt-0.5 whitespace-normal text-[11px] leading-4 text-muted-foreground group-data-[state=checked]:text-slate-100">{option.description}</p>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {(kpiMode === "atomic" || kpiMode === "composite") && (
        <div className="space-y-2">
          <Label className="text-caption text-muted-foreground">Cálculo</Label>
          <div className="rounded-lg border border-border/60 bg-background/70 p-2.5">
            <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              {isCompositeSentence && (
                <>
                  <SentenceTokenSelect
                    tone="agg"
                    value={kpiSentenceFinalAgg}
                    onChange={setKpiSentenceFinalAgg}
                    options={kpiFinalAggOptions.map((item) => ({ value: item.value, label: item.label }))}
                  />
                  <span>de</span>
                  <span>(</span>
                </>
              )}
              <SentenceTokenSelect
                tone="agg"
                value={kpiSentenceBaseAgg}
                onChange={setKpiSentenceBaseAgg}
                options={kpiBaseAggOptions.map((item) => ({
                  value: item.value,
                  label: item.label,
                  disabled: (item.value === "sum" || item.value === "avg") && numericColumns.length === 0,
                }))}
              />
              <span>de</span>
              <SentenceTokenSelect
                tone="column"
                value={kpiSentenceColumn}
                onChange={setKpiSentenceColumn}
                options={[
                  ...(countLikeOps.has(kpiSentenceBaseAgg) ? [{ value: "__none__", label: "sem coluna" }] : []),
                  ...kpiAllowedColumns.map((column) => ({
                    value: column.name,
                    label: column.name,
                  })),
                ]}
              />
              {isCompositeSentence && (
                <>
                  <span>por</span>
                  <SentenceTokenSelect
                    tone="time"
                    value={kpiTimeTokenValue}
                    onChange={setKpiSentenceTimeToken}
                    options={kpiTimeTokenOptions.length > 0
                      ? kpiTimeTokenOptions
                      : [{ value: "__none__::day", label: "sem coluna temporal", disabled: true }]}
                    placeholder="tempo[gran]"
                    showCalendarIcon
                  />
                  <span>)</span>
                </>
              )}
            </div>
          </div>
          <p className="text-caption text-muted-foreground">Preview: {kpiSentencePreview}</p>
        </div>
      )}

      {kpiMode === "derived" && (
        <div className="space-y-2">
          {normalizedDerivedDeps.map((item, index: number) => (
            <div key={`kpi-derived-base-${index}`} className="grid grid-cols-[minmax(0,1fr)_112px_minmax(0,1fr)_30px] gap-1.5 items-center">
              <Input
                className="h-8 text-xs font-mono"
                value={item.alias || ""}
                placeholder={`kpi_${index}`}
                onChange={(e) => {
                  const nextDeps = [...(draft.config.kpi_dependencies || normalizedDerivedDeps)];
                  nextDeps[index] = { ...nextDeps[index], alias: e.target.value };
                  setConfig({ kpi_dependencies: nextDeps });
                }}
              />
              <Select
                value={item.source_type === "column" ? "column" : "widget"}
                onValueChange={(value: string) => {
                  const nextDeps = [...(draft.config.kpi_dependencies || normalizedDerivedDeps)];
                  nextDeps[index] = value === "column"
                    ? {
                        alias: item.alias,
                        source_type: "column",
                        column: item.column || resolvedColumns[0]?.name,
                      }
                    : {
                        alias: item.alias,
                        source_type: "widget",
                        widget_id: normalizeKpiDependencyWidgetId(item.widget_id)
                          ?? normalizeKpiDependencyWidgetId(availableDashboardKpiWidgets[0]?.id),
                      };
                  setConfig({ kpi_dependencies: nextDeps });
                }}
              >
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="widget">KPI</SelectItem>
                  <SelectItem value="column">Coluna</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={item.source_type === "column" ? String(item.column || "__none__") : String(item.widget_id || 0)}
                onValueChange={(value: string) => {
                  const nextDeps = [...(draft.config.kpi_dependencies || normalizedDerivedDeps)];
                  if (item.source_type === "column") {
                    nextDeps[index] = { ...item, source_type: "column", column: value === "__none__" ? "" : value };
                  } else {
                    nextDeps[index] = {
                      ...item,
                      source_type: "widget",
                      widget_id: value === "0" ? undefined : normalizeKpiDependencyWidgetId(value),
                    };
                  }
                  setConfig({ kpi_dependencies: nextDeps });
                }}
              >
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Base" /></SelectTrigger>
                <SelectContent>
                  {item.source_type === "column"
                    ? (
                      <>
                        <SelectItem value="__none__">Sem coluna</SelectItem>
                        {resolvedColumns.map((col) => (
                          <SelectItem key={`${col.name}:${index}`} value={col.name}>{col.name}</SelectItem>
                        ))}
                      </>
                    )
                    : availableDashboardKpiWidgets.map((depWidget) => (
                      <SelectItem key={`${depWidget.id}-${index}`} value={String(depWidget.id)}>
                        #{depWidget.id} · {depWidget.title || "KPI sem título"}
                      </SelectItem>
                    ))}
                  {item.source_type === "widget" && availableDashboardKpiWidgets.length === 0 && (
                    <SelectItem value="0" disabled>Nenhum KPI disponível</SelectItem>
                  )}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                onClick={() => {
                  const nextDeps = normalizedDerivedDeps.filter((_, depIndex: number) => depIndex !== index);
                  setConfig({ kpi_dependencies: nextDeps });
                }}
                disabled={normalizedDerivedDeps.length <= 1}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-caption"
              onClick={() => {
                const nextDeps = [...normalizedDerivedDeps, createDefaultKpiDependency(normalizedDerivedDeps.length)];
                setConfig({ kpi_dependencies: nextDeps });
              }}
              disabled={resolvedColumns.length === 0 && availableDashboardKpiWidgets.length === 0}
            >
              <Plus className="h-3.5 w-3.5 mr-1" />Adicionar base
            </Button>
            <span className="text-caption text-muted-foreground">Aliases: {derivedMetricAliases.join(", ") || "-"}</span>
          </div>
          <div className="space-y-1">
            <Label className="text-caption text-muted-foreground">Fórmula</Label>
            <Input
              className="h-8 text-xs font-mono"
              value={draft.config.formula || ""}
              onChange={(event) =>
                setConfig({
                  formula: event.target.value,
                  dependencies: extractKpiFormulaRefs(event.target.value),
                })}
              placeholder="Ex: SUM(receita) / COUNT(clientes)"
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-[160px_minmax(0,1fr)] items-center gap-2">
        <Label className="text-caption text-muted-foreground">Comparar período</Label>
        <div className="flex items-center justify-end gap-2">
          <span className="text-[11px] text-muted-foreground">{draft.config.kpi_show_trend ? "Ativa" : "Desativada"}</span>
          <Switch
            checked={!!draft.config.kpi_show_trend}
            onCheckedChange={(checked) => setConfig({ kpi_show_trend: checked })}
          />
        </div>
      </div>
    </div>
  );
};



