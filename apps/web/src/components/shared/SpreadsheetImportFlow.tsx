import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowUpDown,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileSpreadsheet,
  FileUp,
  Hash,
  Layers,
  Settings2,
  SlidersHorizontal,
  ToggleLeft,
  Type,
  Upload,
  X,
} from "lucide-react";

import LoadingButton from "@/components/shared/LoadingButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { api, ApiError, ApiSpreadsheetImportConfirmSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

type SpreadsheetImportFlowProps = {
  onBack: () => void;
  onCompleted: () => void;
};

type ColumnType = "string" | "number" | "date" | "bool";

type SheetColumn = {
  sourceName: string;
  originalName: string;
  targetName: string;
  type: ColumnType;
  enabled: boolean;
};

type SheetDraft = {
  name: string;
  enabled: boolean;
  headerRow: number;
  delimiter: string;
  skipEmptyRows: boolean;
  trimWhitespace: boolean;
  rowCount: number;
  previewRows: Array<Record<string, unknown>>;
  columns: SheetColumn[];
  loaded: boolean;
  loading: boolean;
};

const DEFAULT_DELIMITER = ",";
const STEPS = ["Upload", "Configurar", "Confirmar"] as const;

const formatFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const isValidSpreadsheetFile = (file: File) =>
  file.name.toLowerCase().endsWith(".csv") || file.name.toLowerCase().endsWith(".xlsx");

const inferColumnsFromSchema = (schema: Array<Record<string, unknown>>): SheetColumn[] =>
  schema
    .map((item) => {
      const sourceName = String(item.source_name || "");
      if (!sourceName) return null;
      const rawType = String(item.type || "string").toLowerCase();
      const type: ColumnType = rawType === "number" || rawType === "date" || rawType === "bool" ? rawType : "string";
      const column: SheetColumn = {
        sourceName,
        originalName: String(item.original_name || sourceName),
        targetName: String(item.target_name || sourceName),
        type,
        enabled: true,
      };
      return column;
    })
    .filter((item): item is SheetColumn => !!item);

const columnTypeIcon = (type: ColumnType) => {
  if (type === "number") return <Hash className="h-3 w-3" />;
  if (type === "date") return <Calendar className="h-3 w-3" />;
  if (type === "bool") return <ToggleLeft className="h-3 w-3" />;
  return <Type className="h-3 w-3" />;
};

const StepIndicator = ({ currentStep }: { currentStep: 0 | 1 | 2 }) => (
  <div className="mb-5 flex items-center gap-1">
    {STEPS.map((label, index) => (
      <div key={label} className="flex flex-1 items-center gap-1">
        <div className={cn("flex flex-1 items-center gap-2", index <= currentStep ? "text-foreground" : "text-muted-foreground")}>
          <div className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
            index < currentStep && "bg-emerald-500 text-white",
            index === currentStep && "bg-accent text-accent-foreground",
            index > currentStep && "bg-muted text-muted-foreground",
          )}>
            {index < currentStep ? <Check className="h-3 w-3" /> : index + 1}
          </div>
          <span className="hidden text-[11px] font-medium sm:inline">{label}</span>
        </div>
        {index < STEPS.length - 1 && <div className={cn("h-px min-w-3 flex-1", index < currentStep ? "bg-emerald-500" : "bg-border")} />}
      </div>
    ))}
  </div>
);

const SheetPill = ({
  sheet,
  active,
  onClick,
  onToggleEnabled,
}: {
  sheet: SheetDraft;
  active: boolean;
  onClick: () => void;
  onToggleEnabled: (checked: boolean) => void;
}) => (
  <div
    className={cn(
      "flex w-full items-center gap-2 rounded-lg border px-2 py-2 transition-colors",
      active ? "border-accent/40 bg-accent/5" : "border-border bg-card hover:border-border/70",
      !sheet.enabled && "opacity-75",
    )}
  >
    <button type="button" onClick={onClick} className="min-w-0 flex-1 text-left">
      <p className="truncate text-xs font-semibold text-foreground">{sheet.name}</p>
      <p className="text-[11px] text-muted-foreground">{sheet.rowCount.toLocaleString("pt-BR")} linhas</p>
    </button>
    <div className="flex shrink-0 items-center gap-2 rounded-md border border-border/60 bg-background/70 px-2 py-1">
      {sheet.loading && <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />}
      {sheet.loaded && !sheet.loading && <span className={cn("h-2 w-2 rounded-full", sheet.enabled ? "bg-emerald-500" : "bg-muted-foreground/40")} />}
      {!sheet.loaded && !sheet.loading && <span className="h-2 w-2 rounded-full bg-muted" />}
      <Switch
        checked={sheet.enabled}
        onCheckedChange={onToggleEnabled}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Importar aba ${sheet.name}`}
      />
    </div>
  </div>
);

const SpreadsheetImportFlow = ({ onBack, onCompleted }: SpreadsheetImportFlowProps) => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [dragActive, setDragActive] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [importId, setImportId] = useState<number | null>(null);
  const [fileFormat, setFileFormat] = useState<"csv" | "xlsx" | null>(null);
  const [activeSheetTab, setActiveSheetTab] = useState("0");
  const [sheetPanelTab, setSheetPanelTab] = useState<"config" | "preview">("config");
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [sheets, setSheets] = useState<SheetDraft[]>([]);

  const enabledSheets = useMemo(() => sheets.filter((sheet) => sheet.enabled), [sheets]);
  const enabledSheetCount = enabledSheets.length;
  const totalRows = useMemo(() => enabledSheets.reduce((sum, sheet) => sum + sheet.rowCount, 0), [enabledSheets]);
  const totalEnabledColumns = useMemo(() => enabledSheets.reduce((sum, sheet) => sum + sheet.columns.filter((c) => c.enabled).length, 0), [enabledSheets]);
  const isCsv = fileFormat === "csv";
  const activeSheetIndex = Number(activeSheetTab);
  const activeSheet = Number.isNaN(activeSheetIndex) ? null : sheets[activeSheetIndex] ?? null;
  const activePreviewColumns = (activeSheet?.columns || []).filter((column) => column.enabled);

  const updateSheet = useCallback((sheetIndex: number, updater: (sheet: SheetDraft) => SheetDraft) => {
    setSheets((prev) => prev.map((sheet, index) => (index === sheetIndex ? updater(sheet) : sheet)));
  }, []);

  const loadSheetData = useCallback(async (sheetIndex: number, overrides?: Partial<Pick<SheetDraft, "headerRow" | "delimiter">>) => {
    if (!importId) return;
    const targetSheet = sheets[sheetIndex];
    if (!targetSheet || targetSheet.loading) return;
    const headerRow = Math.max(1, overrides?.headerRow ?? targetSheet.headerRow);
    const delimiter = overrides?.delimiter ?? (targetSheet.delimiter || DEFAULT_DELIMITER);

    setSheets((prev) => prev.map((sheet, index) => (index === sheetIndex ? { ...sheet, loading: true } : sheet)));

    try {
      const transformed = await api.updateSpreadsheetImportTransform(importId, {
        header_row: headerRow,
        sheet_name: fileFormat === "xlsx" ? targetSheet.name : undefined,
        delimiter,
      });
      const inferredColumns = inferColumnsFromSchema((transformed.inferred_schema || []) as Array<Record<string, unknown>>);

      setSheets((prev) => prev.map((sheet, index) => {
        if (index !== sheetIndex) return sheet;
        const previousBySource = new Map(sheet.columns.map((column) => [column.sourceName, column]));
        return {
          ...sheet,
          rowCount: transformed.row_count || 0,
          previewRows: (transformed.preview_rows || []) as Array<Record<string, unknown>>,
          columns: inferredColumns.map((column) => {
            const prevColumn = previousBySource.get(column.sourceName);
            return prevColumn ? { ...column, enabled: prevColumn.enabled, targetName: prevColumn.targetName, type: prevColumn.type } : column;
          }),
          loaded: true,
          loading: false,
        };
      }));
    } catch (error) {
      setSheets((prev) => prev.map((sheet, index) => (index === sheetIndex ? { ...sheet, loading: false } : sheet)));
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao carregar aba";
      toast({ title: "Erro ao carregar configuracao", description: message, variant: "destructive" });
    }
  }, [fileFormat, importId, sheets, toast]);

  useEffect(() => {
    if (step !== 1 || sheets.length === 0) return;
    const index = Number(activeSheetTab);
    if (Number.isNaN(index)) return;
    const targetSheet = sheets[index];
    if (!targetSheet || targetSheet.loaded || targetSheet.loading) return;
    void loadSheetData(index);
  }, [activeSheetTab, loadSheetData, sheets, step]);

  const startSpreadsheetImport = useMutation({
    mutationFn: async () => {
      if (!name.trim() || !file) throw new Error("Nome e arquivo sao obrigatorios");
      const created = await api.createSpreadsheetImport({
        tenant_id: 1,
        name: name.trim(),
        description: description.trim() || undefined,
        timezone: "UTC",
        header_row: 1,
        delimiter: DEFAULT_DELIMITER,
      });
      const uploaded = await api.uploadSpreadsheetImportFile(created.id, file);
      return { created, uploaded };
    },
    onSuccess: ({ created, uploaded }) => {
      const names = uploaded.file_format === "xlsx" && (uploaded.available_sheet_names?.length || 0) > 0 ? uploaded.available_sheet_names : ["Dados"];
      setImportId(created.id);
      setFileFormat((uploaded.file_format as "csv" | "xlsx" | null) || null);
      setSheets(names.map((sheetName) => ({ name: sheetName, enabled: true, headerRow: 1, delimiter: DEFAULT_DELIMITER, skipEmptyRows: true, trimWhitespace: true, rowCount: 0, previewRows: [], columns: [], loaded: false, loading: false })));
      setActiveSheetTab("0");
      setSheetPanelTab("config");
      setStep(1);
      toast({ title: "Upload concluido", description: "Configure abas, colunas e tipos antes de confirmar." });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao importar planilha";
      toast({ title: "Erro ao importar planilha", description: message, variant: "destructive" });
    },
  });

  const confirmImport = useMutation({
    mutationFn: async (): Promise<ApiSpreadsheetImportConfirmSummary> => {
      if (!importId) throw new Error("Importacao nao iniciada");
      const selectedSheets = sheets.filter((sheet) => sheet.enabled);
      if (selectedSheets.length === 0) throw new Error("Selecione pelo menos uma aba para importar");

      const allTables: ApiSpreadsheetImportConfirmSummary["tables"] = [];
      const allErrors: Array<Record<string, unknown>> = [];
      let totalRowsProcessed = 0;
      let datasourceId: number | null = null;

      for (const sheet of selectedSheets) {
        const transformResponse = await api.updateSpreadsheetImportTransform(importId, {
          header_row: Math.max(1, sheet.headerRow),
          sheet_name: fileFormat === "xlsx" ? sheet.name : undefined,
          delimiter: sheet.delimiter || DEFAULT_DELIMITER,
        });

        const columns = sheet.columns.filter((column) => column.enabled).map((column) => ({
          source_name: column.sourceName,
          target_name: column.targetName,
          type: column.type,
        }));

        if (columns.length > 0) {
          await api.updateSpreadsheetImportSchema(importId, { columns });
        } else {
          const inferredColumns = inferColumnsFromSchema((transformResponse.inferred_schema || []) as Array<Record<string, unknown>>);
          if (inferredColumns.length > 0) {
            await api.updateSpreadsheetImportSchema(importId, {
              columns: inferredColumns.map((column) => ({ source_name: column.sourceName, target_name: column.targetName, type: column.type })),
            });
          }
        }

        const result = await api.confirmSpreadsheetImport(importId);
        datasourceId = datasourceId ?? result.datasource_id;
        allTables.push(...result.tables);
        totalRowsProcessed += result.row_count;
        allErrors.push(...(result.error_samples || []));
      }

      return { import_id: importId, datasource_id: datasourceId ?? 0, row_count: totalRowsProcessed, tables: allTables, error_samples: allErrors, status: "completed" };
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["datasources"] }),
        queryClient.invalidateQueries({ queryKey: ["views"] }),
        queryClient.invalidateQueries({ queryKey: ["datasets"] }),
      ]);
      toast({ title: "Importacao confirmada", description: `${result.tables.length} tabela(s) criada(s), ${result.row_count.toLocaleString("pt-BR")} linhas processadas.` });
      onCompleted();
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : String((error as Error)?.message || error);
      toast({ title: "Erro ao confirmar importacao", description: message, variant: "destructive" });
    },
  });

  const handleFileProcess = (nextFile: File) => {
    if (!isValidSpreadsheetFile(nextFile)) {
      toast({ title: "Arquivo invalido", description: "Use apenas .csv ou .xlsx.", variant: "destructive" });
      return;
    }
    setFile(nextFile);
    if (!name.trim()) setName(nextFile.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "));
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) handleFileProcess(droppedFile);
  };

  const handleGoToConfirm = async () => {
    const notLoadedIndexes = sheets.map((sheet, index) => ({ sheet, index })).filter((entry) => entry.sheet.enabled && !entry.sheet.loaded).map((entry) => entry.index);
    for (const idx of notLoadedIndexes) {
      await loadSheetData(idx);
    }
    setStep(2);
  };

  const handleSheetPanelTabChange = async (nextTab: "config" | "preview") => {
    setSheetPanelTab(nextTab);
    if (nextTab !== "preview") return;
    if (!activeSheet || activeSheetIndex < 0) return;
    await loadSheetData(activeSheetIndex);
  };

  return (
    <div className="mt-0 flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-hidden">
      <StepIndicator currentStep={step} />

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait">
        {step === 0 && (
          <motion.div key="upload" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="h-full min-w-0 space-y-3 overflow-y-auto overflow-x-hidden pr-1">
            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
              <div
                className={cn(
                  "min-w-0 cursor-pointer rounded-2xl border-2 border-dashed p-5 transition-colors",
                  dragActive && "border-accent bg-accent/5",
                  !dragActive && !file && "border-border hover:border-muted-foreground/40",
                  file && "border-emerald-500/40 bg-emerald-500/5",
                )}
                onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setDragActive(true); }}
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragActive(true); }}
                onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDragActive(false); }}
                onDrop={handleDrop}
                onClick={() => inputRef.current?.click()}
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept=".csv,.xlsx"
                  className="hidden"
                  onChange={(e) => {
                    const selected = e.target.files?.[0];
                    if (selected) handleFileProcess(selected);
                  }}
                />

                {file ? (
                  <div className="space-y-4">
                    <div className="flex items-start gap-3">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600">
                        <FileSpreadsheet className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-semibold text-foreground">{file.name}</p>
                          <Badge variant="secondary" className="text-[10px] uppercase">{file.name.toLowerCase().endsWith(".csv") ? "CSV" : "XLSX"}</Badge>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
                      </div>
                      <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={(e) => { e.stopPropagation(); setFile(null); }}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="rounded-xl border border-border/70 bg-background/70 p-3 text-xs text-muted-foreground">
                      No proximo passo voce seleciona abas, renomeia colunas e ajusta tipos antes da importacao.
                    </div>
                  </div>
                ) : (
                  <div className="flex min-h-[220px] flex-col items-center justify-center text-center">
                    <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-muted text-muted-foreground"><FileUp className="h-5 w-5" /></div>
                    <p className="text-sm font-semibold text-foreground">Arraste sua planilha</p>
                    <p className="mt-1 text-xs text-muted-foreground">ou clique para selecionar um arquivo CSV ou XLSX</p>
                    <div className="mt-4 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <Badge variant="secondary" className="rounded-md px-2 py-0">CSV</Badge>
                      <Badge variant="secondary" className="rounded-md px-2 py-0">XLSX</Badge>
                    </div>
                  </div>
                )}
              </div>

              <div className="min-w-0 rounded-2xl border border-border bg-card p-4">
                <div className="mb-4 flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent"><Upload className="h-4 w-4" /></div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">Metadados da fonte</p>
                    <p className="text-xs text-muted-foreground">Usados para registrar o datasource de planilha.</p>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="import-name">Nome da Fonte</Label>
                    <Input id="import-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Relatorio Financeiro Q1" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="import-desc">Descricao</Label>
                    <Textarea id="import-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="Contexto e uso esperado..." />
                  </div>
                </div>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
              <Button variant="outline" className="w-auto" onClick={onBack}><ArrowLeft className="mr-1 h-4 w-4" />Voltar</Button>
              <LoadingButton loading={startSpreadsheetImport.isPending} loadingText="Enviando..." className="w-auto bg-accent text-accent-foreground hover:bg-accent/90" disabled={!file || !name.trim()} onClick={() => startSpreadsheetImport.mutate()}>
                Configurar Importacao<ChevronRight className="ml-1 h-4 w-4" />
              </LoadingButton>
            </div>
          </motion.div>
        )}

        {step === 1 && (
          <motion.div key="config" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden pr-1 xl:overflow-hidden xl:pr-0">
            <div className="grid min-w-0 gap-2 text-xs sm:grid-cols-2 xl:grid-cols-4">
              <div className="min-w-0 rounded-xl border border-border bg-card px-3 py-2.5"><p className="text-muted-foreground">Arquivo</p><p className="truncate font-semibold text-foreground">{file?.name || "-"}</p></div>
              <div className="min-w-0 rounded-xl border border-border bg-card px-3 py-2.5"><p className="text-muted-foreground">Abas ativas</p><p className="font-semibold text-foreground">{enabledSheetCount}</p></div>
              <div className="min-w-0 rounded-xl border border-border bg-card px-3 py-2.5"><p className="text-muted-foreground">Linhas (preview)</p><p className="font-semibold text-foreground">{totalRows.toLocaleString("pt-BR")}</p></div>
              <div className="min-w-0 rounded-xl border border-border bg-card px-3 py-2.5"><p className="text-muted-foreground">Colunas ativas</p><p className="font-semibold text-foreground">{totalEnabledColumns}</p></div>
            </div>

            <div className="grid min-h-0 min-w-0 flex-1 gap-4 xl:grid-cols-[minmax(0,250px)_minmax(0,1fr)]">
              <div className="flex min-h-0 min-w-0 flex-col rounded-2xl border border-border bg-card p-3">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2"><Layers className="h-4 w-4 text-muted-foreground" /><p className="text-sm font-semibold text-foreground">Abas</p></div>
                  <Badge variant="secondary" className="text-[10px]">{sheets.length}</Badge>
                </div>
                <ScrollArea className="min-h-[180px] flex-1 pr-2 xl:min-h-0">
                  <div className="space-y-2">
                    {sheets.map((sheet, index) => (
                      <SheetPill
                        key={`${sheet.name}-${index}`}
                        sheet={sheet}
                        active={activeSheetTab === String(index)}
                        onClick={() => setActiveSheetTab(String(index))}
                        onToggleEnabled={(checked) => updateSheet(index, (c) => ({ ...c, enabled: checked }))}
                      />
                    ))}
                  </div>
                </ScrollArea>
              </div>

              <div className="min-h-0 min-w-0 space-y-3">
                {activeSheet ? (
                  <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card p-4">
                    <Tabs value={sheetPanelTab} onValueChange={(v) => { void handleSheetPanelTabChange(v as "config" | "preview"); }} className="flex min-h-0 min-w-0 flex-1 flex-col space-y-3">
                      <div className="mb-1 flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2"><p className="text-sm font-semibold text-foreground">{activeSheet.name}</p>{activeSheet.loading && <Badge variant="secondary">Atualizando...</Badge>}</div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <TabsList className="h-8 shrink-0 bg-muted/40">
                            <TabsTrigger value="config" className="h-7 gap-1.5 px-2.5 text-xs"><Settings2 className="h-3.5 w-3.5" />Configurar</TabsTrigger>
                            <TabsTrigger value="preview" className="h-7 gap-1.5 px-2.5 text-xs"><Eye className="h-3.5 w-3.5" />Preview</TabsTrigger>
                          </TabsList>
                          <Dialog open={advancedSettingsOpen} onOpenChange={setAdvancedSettingsOpen}>
                            <DialogTrigger asChild>
                              <Button type="button" variant="outline" size="icon" className="h-8 w-8" aria-label="Configuracoes avancadas">
                                <SlidersHorizontal className="h-4 w-4" />
                              </Button>
                            </DialogTrigger>
                            <DialogContent className="sm:max-w-md">
                              <DialogHeader>
                                <DialogTitle className="text-base">Configuracoes avancadas da aba</DialogTitle>
                                <DialogDescription>
                                  Ajustes locais para o processamento da aba selecionada.
                                </DialogDescription>
                              </DialogHeader>
                              <div className="space-y-3">
                                <div className="flex items-center justify-between rounded-lg border border-border bg-muted/10 px-3 py-2.5">
                                  <div>
                                    <p className="text-sm font-medium text-foreground">Ignorar linhas vazias</p>
                                    <p className="text-xs text-muted-foreground">Nao aplica linhas totalmente vazias no processamento.</p>
                                  </div>
                                  <Switch checked={activeSheet.skipEmptyRows} onCheckedChange={(checked) => updateSheet(activeSheetIndex, (c) => ({ ...c, skipEmptyRows: checked }))} />
                                </div>
                                <div className="flex items-center justify-between rounded-lg border border-border bg-muted/10 px-3 py-2.5">
                                  <div>
                                    <p className="text-sm font-medium text-foreground">Remover espacos extras</p>
                                    <p className="text-xs text-muted-foreground">Trim local nas celulas antes de confirmar a importacao.</p>
                                  </div>
                                  <Switch checked={activeSheet.trimWhitespace} onCheckedChange={(checked) => updateSheet(activeSheetIndex, (c) => ({ ...c, trimWhitespace: checked }))} />
                                </div>
                                <p className="text-[11px] text-muted-foreground">
                                  No backend atual, linha de cabecalho e delimitador sao aplicados. Esses toggles permanecem como configuracao local da UI.
                                </p>
                              </div>
                            </DialogContent>
                          </Dialog>
                        </div>
                      </div>

                      <TabsContent value="config" className="mt-0 min-h-0 min-w-0 flex-1 space-y-3">
                        <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
                          <div className={cn(
                            "grid min-w-0 gap-3 rounded-xl border border-border bg-muted/10 p-3",
                            isCsv ? "md:grid-cols-[minmax(0,220px)_minmax(0,220px)_1fr]" : "md:grid-cols-[minmax(0,220px)_1fr]",
                          )}>
                            <div className="space-y-1.5">
                              <Label className="text-xs">Linha do cabecalho</Label>
                              <Select value={String(activeSheet.headerRow)} onValueChange={(value) => updateSheet(activeSheetIndex, (c) => ({ ...c, headerRow: Math.max(1, Number(value) || 1), loaded: false }))}>
                                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent>{[1, 2, 3, 4, 5].map((n) => <SelectItem key={n} value={String(n)}>Linha {n}</SelectItem>)}</SelectContent>
                              </Select>
                            </div>
                            {isCsv ? (
                              <div className="space-y-1.5">
                                <Label className="text-xs">Delimitador (CSV)</Label>
                                <Select value={activeSheet.delimiter} onValueChange={(value) => updateSheet(activeSheetIndex, (c) => ({ ...c, delimiter: value, loaded: false }))}>
                                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value=",">Virgula (,)</SelectItem><SelectItem value=";">Ponto e virgula (;)</SelectItem><SelectItem value="|">Pipe (|)</SelectItem><SelectItem value="\t">Tab</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            ) : null}
                            <div className="flex items-end justify-start md:justify-end">
                              <p className="text-[11px] text-muted-foreground">
                                Alterar cabecalho ou delimitador atualiza a deteccao de colunas quando voce abrir o preview.
                              </p>
                            </div>
                          </div>

                          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                            <div className="mb-2 flex items-center justify-between">
                              <div className="flex items-center gap-2"><ArrowUpDown className="h-4 w-4 text-muted-foreground" /><p className="text-xs font-semibold text-foreground">Colunas</p></div>
                              <Badge variant="secondary" className="text-[10px]">{activeSheet.columns.filter((c) => c.enabled).length}/{activeSheet.columns.length}</Badge>
                            </div>
                            <ScrollArea className="min-h-[240px] min-w-0 flex-1 rounded-lg border border-border/70 bg-background/40">
                              <div className="space-y-2 p-2">
                                {activeSheet.columns.map((column, columnIndex) => (
                                  <div key={column.sourceName} className="rounded-lg border border-border bg-card p-2">
                                    <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center">
                                      <div className="flex min-w-0 flex-1 items-start gap-2">
                                        <Checkbox checked={column.enabled} onCheckedChange={() => updateSheet(activeSheetIndex, (c) => ({ ...c, columns: c.columns.map((item, idx) => idx === columnIndex ? { ...item, enabled: !item.enabled } : item) }))} />
                                        <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-foreground" title={column.originalName}>{column.originalName}</p><p className="truncate text-[10px] text-muted-foreground" title={column.sourceName}>{column.sourceName}</p></div>
                                      </div>
                                      <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,1fr)_168px]">
                                        <Input value={column.targetName} onChange={(e) => updateSheet(activeSheetIndex, (c) => ({ ...c, columns: c.columns.map((item, idx) => idx === columnIndex ? { ...item, targetName: e.target.value } : item) }))} className="h-8 min-w-0 text-xs" placeholder="nome_destino" />
                                        <Select value={column.type} onValueChange={(value) => updateSheet(activeSheetIndex, (c) => ({ ...c, columns: c.columns.map((item, idx) => idx === columnIndex ? { ...item, type: value as ColumnType } : item) }))}>
                                          <SelectTrigger className="h-8 w-full min-w-0 text-xs">
                                            <span className="inline-flex items-center gap-1 whitespace-nowrap">
                                              {columnTypeIcon(column.type)}
                                              <SelectValue />
                                            </span>
                                          </SelectTrigger>
                                          <SelectContent><SelectItem value="string">Texto</SelectItem><SelectItem value="number">Numero</SelectItem><SelectItem value="date">Data</SelectItem><SelectItem value="bool">Booleano</SelectItem></SelectContent>
                                        </Select>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                                {activeSheet.columns.length === 0 && <div className="flex h-28 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">Nenhuma coluna detectada ainda. Abra o preview para atualizar a deteccao.</div>}
                              </div>
                            </ScrollArea>
                          </div>
                        </div>
                      </TabsContent>

                      <TabsContent value="preview" className="mt-0 min-h-0 min-w-0 flex-1 space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                          {activePreviewColumns.slice(0, 10).map((column) => <Badge key={column.sourceName} variant="outline" className="gap-1 text-[10px]">{columnTypeIcon(column.type)}{column.targetName}</Badge>)}
                          {activePreviewColumns.length > 10 && <Badge variant="secondary" className="text-[10px]">+{activePreviewColumns.length - 10}</Badge>}
                        </div>
                        {activeSheet.previewRows.length > 0 && activePreviewColumns.length > 0 ? (
                          <div className="min-h-[260px] min-w-0 flex-1 overflow-hidden rounded-xl border border-border">
                            <Table className="min-w-max">
                              <TableHeader><TableRow className="bg-muted/30 hover:bg-muted/30">{activePreviewColumns.map((column) => <TableHead key={column.sourceName} className="whitespace-nowrap text-xs font-semibold"><div className="flex items-center gap-1">{columnTypeIcon(column.type)}<span>{column.targetName}</span></div></TableHead>)}</TableRow></TableHeader>
                              <TableBody>
                                {activeSheet.previewRows.slice(0, 8).map((row, rowIndex) => (
                                  <TableRow key={`preview-${rowIndex}`}>{activePreviewColumns.map((column) => <TableCell key={`${rowIndex}-${column.sourceName}`} className="max-w-[240px] text-xs"><span className="block truncate" title={String(row[column.sourceName] ?? "")}>{String(row[column.sourceName] ?? "")}</span></TableCell>)}</TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        ) : <div className="flex min-h-[180px] items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground">Gere o preview da aba para visualizar amostras de dados.</div>}
                      </TabsContent>
                    </Tabs>
                  </div>
                ) : <div className="flex min-h-[240px] items-center justify-center rounded-2xl border border-dashed border-border bg-card text-sm text-muted-foreground">Selecione uma aba.</div>}
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
              <Button variant="outline" className="w-auto" onClick={() => setStep(0)}><ChevronLeft className="mr-1 h-4 w-4" />Voltar para Upload</Button>
              <Button className="w-auto bg-accent text-accent-foreground hover:bg-accent/90" onClick={handleGoToConfirm} disabled={enabledSheetCount === 0}>Revisar e Confirmar<ChevronRight className="ml-1 h-4 w-4" /></Button>
            </div>
          </motion.div>
        )}

        {step === 2 && (
          <motion.div key="confirm" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="h-full min-w-0 space-y-4 overflow-y-auto overflow-x-hidden pr-1">
            <div className="min-w-0 rounded-2xl border border-border bg-card p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-foreground">Resumo da Importacao</p>
                  <p className="mt-1 text-xs text-muted-foreground">{enabledSheetCount} abas, {totalRows.toLocaleString("pt-BR")} linhas e {totalEnabledColumns} colunas ativas.</p>
                </div>
                <div className="flex flex-wrap gap-2"><Badge variant="secondary">{enabledSheetCount} abas</Badge><Badge variant="secondary">{totalEnabledColumns} colunas</Badge><Badge variant="secondary">{totalRows.toLocaleString("pt-BR")} linhas</Badge></div>
              </div>
              <div className="mt-4 grid gap-3">
                {enabledSheets.map((sheet) => {
                  const selectedColumns = sheet.columns.filter((c) => c.enabled);
                  return (
                    <div key={sheet.name} className="rounded-xl border border-border bg-muted/15 p-3">
                      <p className="text-sm font-medium text-foreground">{sheet.name}</p>
                      <p className="text-xs text-muted-foreground">{sheet.rowCount.toLocaleString("pt-BR")} linhas . {selectedColumns.length} colunas selecionadas</p>
                      <div className="mt-2 flex flex-wrap gap-1">{selectedColumns.slice(0, 6).map((column) => <Badge key={`${sheet.name}-${column.sourceName}`} variant="outline" className="gap-1 text-[10px]">{columnTypeIcon(column.type)}{column.targetName}</Badge>)}{selectedColumns.length > 6 && <Badge variant="secondary" className="text-[10px]">+{selectedColumns.length - 6}</Badge>}</div>
                    </div>
                  );
                })}
              </div>
              {enabledSheetCount > 1 && <p className="mt-4 text-xs text-amber-600">A importacao multipla sera executada sequencialmente, uma aba por vez.</p>}
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
              <Button variant="outline" className="w-auto" onClick={() => setStep(1)}><ChevronLeft className="mr-1 h-4 w-4" />Voltar para Configuracao</Button>
              <LoadingButton loading={confirmImport.isPending} loadingText="Importando..." className="w-auto bg-accent text-accent-foreground hover:bg-accent/90" onClick={() => confirmImport.mutate()}>Confirmar Importacao</LoadingButton>
            </div>
          </motion.div>
        )}
        </AnimatePresence>
      </div>
    </div>
  );
};

export default SpreadsheetImportFlow;
