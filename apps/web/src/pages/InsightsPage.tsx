import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { BarChart, Bar, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis, LineChart, Line } from "recharts";
import {
  MessageSquare,
  Send,
  Database,
  Columns3,
  Sparkles,
  Bot,
  User,
  Loader2,
  HelpCircle,
  AlertCircle,
  KeyRound,
  ShieldCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useCoreData } from "@/hooks/use-core-data";
import { api, ApiError, ApiInsightChatResponse } from "@/lib/api";
import { cn } from "@/lib/utils";
import { getStoredUser } from "@/lib/auth";

type ProcessingStep = "analyzing" | "building_query" | "querying" | "generating";

type ChatWidget =
  | {
      widget_type: "kpi";
      title: string;
      value: string | number;
    }
  | {
      widget_type: "table";
      title: string;
      headers: string[];
      rows: (string | number)[][];
    }
  | {
      widget_type: "bar" | "line";
      title: string;
      dimension_key: string;
      metric_key: string;
      rows: Array<Record<string, string | number>>;
    };

type LLMContext = {
  planner_response_id?: string | null;
  answer_response_id?: string | null;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "clarification" | "error";
  content: string;
  timestamp: Date;
  widgets?: ChatWidget[];
  processingStep?: ProcessingStep;
  stages?: ProcessingStep[];
};

const STEP_LABELS: Record<ProcessingStep, string> = {
  analyzing: "Analisando pergunta...",
  building_query: "Montando consulta...",
  querying: "Consultando dados...",
  generating: "Gerando resposta...",
};

const STEP_ORDER: ProcessingStep[] = ["analyzing", "building_query", "querying", "generating"];

const ProcessingIndicator = ({ step, steps = [step] }: { step: ProcessingStep; steps?: ProcessingStep[] }) => (
  <div className="flex items-start gap-3 py-3">
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10">
      <Bot className="h-4 w-4 text-accent" />
    </div>
    <div className="space-y-2 pt-1">
      {steps.map((s) => {
        const idx = STEP_ORDER.indexOf(s);
        const currentIdx = STEP_ORDER.indexOf(step);
        const done = idx < currentIdx;
        const active = idx === currentIdx;
        return (
          <div
            key={s}
            className={cn(
              "flex items-center gap-2 text-xs transition-colors",
              done && "text-success",
              active && "text-foreground font-medium",
              !done && !active && "text-muted-foreground/50",
            )}
          >
            {active ? <Loader2 className="h-3 w-3 animate-spin" /> : done ? <Sparkles className="h-3 w-3" /> : <span className="h-3 w-3" />}
            {STEP_LABELS[s]}
          </div>
        );
      })}
    </div>
  </div>
);

const formatCompactNumber = (value: unknown): string => {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(number);
};

const renderBoldMarkdown = (content: string) => {
  const parts = content.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    const boldMatch = /^\*\*([^*]+)\*\*$/.exec(part);
    if (boldMatch) return <strong key={idx}>{boldMatch[1]}</strong>;
    return <span key={idx}>{part}</span>;
  });
};

const toTableRows = (headers: string[], rows: Record<string, unknown>[], limit = 15): (string | number)[][] =>
  rows.slice(0, limit).map((row) =>
    headers.map((header) => {
      const value = row[header];
      if (typeof value === "number") return value;
      if (value == null) return "-";
      return String(value);
    }),
  );

const pickMetricColumn = (headers: string[], rows: Record<string, unknown>[]) => {
  if (headers.includes("m0")) return "m0";
  return (
    headers.find((header) =>
      rows.some((row) => {
        const value = row[header];
        return typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)));
      }),
    ) || null
  );
};

const pickDimensionColumn = (headers: string[], metricColumn: string | null, preferred: string[] = []) => {
  const preferredHit = preferred.find((field) => headers.includes(field) && field !== metricColumn);
  if (preferredHit) return preferredHit;
  return headers.find((header) => header !== metricColumn) || null;
};

const buildDynamicWidgets = (response: Extract<ApiInsightChatResponse, { type: "answer" }>): ChatWidget[] => {
  const headers = response.columns || [];
  const rows = response.rows || [];
  const hasRows = response.row_count > 0 && rows.length > 0;
  if (!hasRows || headers.length === 0) return [];

  const hasTimeSeriesShape = headers.includes("time_bucket") || !!response.query_plan?.period?.field;
  const metricColumn = pickMetricColumn(headers, rows);
  const dimensionColumn = pickDimensionColumn(headers, metricColumn, response.query_plan?.dimensions || []);
  const isSimpleAnswer = response.answer.trim().length <= 110 && response.row_count <= 1;
  if (isSimpleAnswer) return [];

  const tableWidget: ChatWidget = {
    widget_type: "table",
    title: "Tabela",
    headers,
    rows: toTableRows(headers, rows, 15),
  };

  if (hasTimeSeriesShape && metricColumn && dimensionColumn) {
    const chartRows = rows
      .map((row) => {
        const x = row[dimensionColumn];
        const y = row[metricColumn];
        const yNum = typeof y === "number" ? y : Number(y);
        if (x == null || !Number.isFinite(yNum)) return null;
        return { [dimensionColumn]: String(x), [metricColumn]: yNum };
      })
      .filter((item): item is Record<string, string | number> => !!item)
      .slice(0, 30);
    if (chartRows.length === 0) return [tableWidget];
    return [
      {
        widget_type: "line",
        title: "Serie temporal",
        dimension_key: dimensionColumn,
        metric_key: metricColumn,
        rows: chartRows,
      },
      ...(response.row_count > 12 ? [tableWidget] : []),
    ];
  }

  if (metricColumn && !dimensionColumn) {
    const rawValue = rows[0]?.[metricColumn];
    const value = typeof rawValue === "number" ? rawValue : Number(rawValue);
    return [
      {
        widget_type: "kpi",
        title: "KPI",
        value: Number.isFinite(value) ? value : String(rawValue ?? "-"),
      },
    ];
  }

  if (metricColumn && dimensionColumn) {
    const chartRows = rows
      .map((row) => {
        const x = row[dimensionColumn];
        const y = row[metricColumn];
        const yNum = typeof y === "number" ? y : Number(y);
        if (x == null || !Number.isFinite(yNum)) return null;
        return { [dimensionColumn]: String(x), [metricColumn]: yNum };
      })
      .filter((item): item is Record<string, string | number> => !!item)
      .slice(0, 20);
    if (chartRows.length === 0) return [tableWidget];
    return [
      {
        widget_type: "bar",
        title: "Ranking",
        dimension_key: dimensionColumn,
        metric_key: metricColumn,
        rows: chartRows,
      },
      ...(response.row_count > 8 ? [tableWidget] : []),
    ];
  }

  return [tableWidget];
};

const MessageBubble = ({ message }: { message: ChatMessage }) => {
  if (message.role === "user") {
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex justify-end">
        <div className="flex items-start gap-2 max-w-[80%]">
          <div className="rounded-2xl rounded-tr-sm bg-accent text-accent-foreground px-4 py-2.5 text-sm">
            {message.content}
          </div>
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10 mt-0.5">
            <User className="h-3.5 w-3.5 text-accent" />
          </div>
        </div>
      </motion.div>
    );
  }

  const isClarification = message.role === "clarification";
  const isError = message.role === "error";

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex items-start gap-3 max-w-[90%]">
      <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5", isError ? "bg-destructive/10" : "bg-accent/10")}>
        {isError ? <AlertCircle className="h-4 w-4 text-destructive" /> : <Bot className="h-4 w-4 text-accent" />}
      </div>
      <div className="space-y-3 flex-1 min-w-0">
        {isClarification && (
          <Badge variant="outline" className="text-[10px] gap-1 text-warning border-warning/30 bg-warning/5">
            <HelpCircle className="h-3 w-3" /> Clarificacao
          </Badge>
        )}

        {isError && (
          <Badge variant="outline" className="text-[10px] gap-1 text-destructive border-destructive/30 bg-destructive/5">
            <AlertCircle className="h-3 w-3" /> Erro controlado
          </Badge>
        )}

        <div className="text-sm text-foreground leading-relaxed whitespace-pre-line">{renderBoldMarkdown(message.content)}</div>

        {message.widgets && message.widgets.length > 0 && (
          <div className="space-y-3">
            {message.widgets.map((widget, idx) => {
              if (widget.widget_type === "kpi") {
                return (
                  <div key={`widget-${idx}`} className="glass-card px-3 py-2.5 flex flex-col">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{widget.title}</span>
                    <span className="text-2xl font-extrabold tracking-tight text-foreground">{formatCompactNumber(widget.value)}</span>
                  </div>
                );
              }

              if (widget.widget_type === "table") {
                return (
                  <div key={`widget-${idx}`} className="rounded-lg border border-border overflow-hidden text-xs">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          {widget.headers.map((h) => (
                            <TableHead key={h} className="text-xs font-semibold py-2 whitespace-nowrap">{h}</TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {widget.rows.map((row, i) => (
                          <TableRow key={i}>
                            {row.map((cell, j) => (
                              <TableCell key={j} className={cn("py-1.5", typeof cell === "number" ? "font-mono text-right tabular-nums" : "")}>{cell}</TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                );
              }

              if (widget.widget_type === "line") {
                return (
                  <div key={`widget-${idx}`} className="rounded-lg border border-border px-2 py-3">
                    <div className="text-[11px] text-muted-foreground mb-2">{widget.title}</div>
                    <div className="h-52">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={widget.rows} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                          <XAxis dataKey={widget.dimension_key} tick={{ fontSize: 10 }} />
                          <YAxis tick={{ fontSize: 10 }} />
                          <ChartTooltip formatter={(value) => formatCompactNumber(value)} />
                          <Line type="monotone" dataKey={widget.metric_key} stroke="hsl(var(--accent))" strokeWidth={2} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                );
              }

              return (
                <div key={`widget-${idx}`} className="rounded-lg border border-border px-2 py-3">
                  <div className="text-[11px] text-muted-foreground mb-2">{widget.title}</div>
                  <div className="h-52">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={widget.rows} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey={widget.dimension_key} tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} />
                        <ChartTooltip formatter={(value) => formatCompactNumber(value)} />
                        <Bar dataKey={widget.metric_key} fill="hsl(var(--accent))" radius={[6, 6, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <span className="text-[10px] text-muted-foreground">
          {message.timestamp.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
        </span>
        {message.stages && message.stages.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            Etapas executadas: {message.stages.map((s) => STEP_LABELS[s]).join(" > ")}
          </span>
        )}
      </div>
    </motion.div>
  );
};

const SidePanelContent = ({
  datasets,
  selectedDatasetId,
  onDatasetChange,
  viewColumns,
}: {
  datasets: Array<{ id: string; name: string }>;
  selectedDatasetId: string | null;
  onDatasetChange: (value: string) => void;
  viewColumns: Array<{ name: string; type: string }>;
}) => (
  <div className="h-full flex flex-col">
    <div className="border-b border-border p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Dataset</p>
      <Select value={selectedDatasetId || ""} onValueChange={onDatasetChange}>
        <SelectTrigger className="w-full h-9 text-sm">
          <SelectValue placeholder="Selecione um dataset..." />
        </SelectTrigger>
        <SelectContent>
          {datasets.map((ds) => (
            <SelectItem key={ds.id} value={ds.id}>
              <span className="flex items-center gap-2">
                <Database className="h-3.5 w-3.5 text-muted-foreground" />
                {ds.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>

    <div className="p-4 pb-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
        <Columns3 className="h-3.5 w-3.5" /> Colunas do Dataset
      </h3>
    </div>

    <div className="flex-1 min-h-0 px-4 pb-4">
      <ScrollArea className="h-full">
        {selectedDatasetId && viewColumns.length > 0 ? (
          <div className="space-y-1.5">
            {viewColumns.map((col) => (
              <div key={col.name} className="flex items-center justify-between rounded-md bg-muted/40 px-2.5 py-1.5">
                <span className="font-mono text-xs text-foreground">{col.name}</span>
                <Badge variant="secondary" className="text-[10px] h-5">{col.type}</Badge>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-md bg-muted/30 px-3 py-3">
            <p className="text-xs text-muted-foreground">Selecione um dataset para ver as colunas.</p>
          </div>
        )}
      </ScrollArea>
    </div>
  </div>
);

const buildAssistantMessage = (response: ApiInsightChatResponse): ChatMessage => {
  if (response.type === "clarification") {
    return {
      id: crypto.randomUUID(),
      role: "clarification",
      content: response.clarification_question,
      timestamp: new Date(),
      stages: response.stages,
    };
  }

  if (response.type === "error") {
    const suggestions = response.suggestions?.length ? `\n\nSugestoes:\n- ${response.suggestions.join("\n- ")}` : "";
    return {
      id: crypto.randomUUID(),
      role: "error",
      content: `${response.message}${suggestions}`,
      timestamp: new Date(),
      stages: response.stages,
    };
  }

  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content: response.answer,
    timestamp: new Date(),
    widgets: buildDynamicWidgets(response),
    stages: response.stages,
  };
};

type InsightsPageProps = {
  initialSection?: "chat" | "config";
};

const InsightsPage = ({ initialSection = "chat" }: InsightsPageProps) => {
  const navigate = useNavigate();
  const { datasets, views } = useCoreData();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const user = getStoredUser();
  const isAdmin = !!user?.is_admin;

  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [processing, setProcessing] = useState<ProcessingStep | null>(null);
  const [llmContext, setLlmContext] = useState<LLMContext>({});
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");

  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const integrationQuery = useQuery({
    queryKey: ["insights", "integration"],
    queryFn: api.getInsightsIntegration,
  });

  useEffect(() => {
    if (integrationQuery.data?.model) {
      setModel(integrationQuery.data.model);
    }
  }, [integrationQuery.data?.model]);

  const saveIntegrationMutation = useMutation({
    mutationFn: () => api.upsertOpenAIIntegration({ api_key: apiKey.trim(), model }),
    onSuccess: async () => {
      setApiKey("");
      await queryClient.invalidateQueries({ queryKey: ["insights", "integration"] });
      toast({ title: "Integracao OpenAI salva" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao salvar integracao";
      toast({ title: "Erro ao salvar", description: message, variant: "destructive" });
    },
  });

  const testIntegrationMutation = useMutation({
    mutationFn: () => api.testOpenAIIntegration({ api_key: apiKey.trim() || undefined, model }),
    onSuccess: () => {
      toast({ title: "Conexao validada", description: "OpenAI respondeu com sucesso." });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao testar conexao";
      toast({ title: "Falha no teste", description: message, variant: "destructive" });
    },
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, processing]);

  const selectedDataset = datasets.find((d) => d.id === selectedDatasetId) || null;
  const selectedView = views.find((v) => v.id === selectedDataset?.viewId) || null;
  const llmConfigured = !!integrationQuery.data?.configured;

  const askMutation = useMutation({
    mutationFn: ({ datasetId, question, history, plannerPreviousResponseId, answerPreviousResponseId }: {
      datasetId: number;
      question: string;
      history: Array<{ role: "user" | "assistant" | "clarification" | "error"; content: string }>;
      plannerPreviousResponseId?: string;
      answerPreviousResponseId?: string;
    }) =>
      api.askInsight({
        dataset_id: datasetId,
        question,
        history,
        planner_previous_response_id: plannerPreviousResponseId,
        answer_previous_response_id: answerPreviousResponseId,
      }),
    onSuccess: (response) => {
      const assistantMessage = buildAssistantMessage(response);
      setMessages((prev) => [...prev, assistantMessage]);
      if (response.llm_context) {
        setLlmContext({
          planner_response_id: response.llm_context.planner_response_id ?? undefined,
          answer_response_id: response.llm_context.answer_response_id ?? undefined,
        });
      }
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao processar pergunta";
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "error",
          content: `Erro controlado: ${message}`,
          timestamp: new Date(),
        },
      ]);
    },
    onSettled: () => {
      setProcessing(null);
      inputRef.current?.focus();
    },
  });

  const handleSend = () => {
    const text = inputValue.trim();
    if (!text || !selectedDatasetId || processing || askMutation.isPending) return;

    if (!llmConfigured) {
      toast({
        title: "LLM nao configurada",
        description: "Configure uma chave OpenAI para usar o Insights.",
        variant: "destructive",
      });
      return;
    }

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputValue("");
    setProcessing("analyzing");
    const history = messages
      .slice(-12)
      .map((item) => ({
        role: item.role,
        content: item.content,
      }))
      .filter((item) => item.content.trim().length > 0);
    askMutation.mutate({
      datasetId: Number(selectedDatasetId),
      question: text,
      history,
      plannerPreviousResponseId: llmContext.planner_response_id || undefined,
      answerPreviousResponseId: llmContext.answer_response_id || undefined,
    });
  };

  const suggestions = useMemo(() => {
    if (!selectedView) return [];
    const cols = selectedView.columns.map((col) => col.name);
    const dim = cols[0] || "categoria";
    const metric = cols.find((col) => col.toLowerCase().includes("valor") || col.toLowerCase().includes("amount")) || cols[1] || "id";
    return [
      `Qual o total de ${metric}?`,
      `Top 5 ${dim} por ${metric}`,
      `Quais colunas posso usar para filtros?`,
    ];
  }, [selectedView]);

  const sidePanelBody = (
    <SidePanelContent
      datasets={datasets.map((ds) => ({ id: ds.id, name: ds.name }))}
      selectedDatasetId={selectedDatasetId}
      onDatasetChange={(value) => {
        setSelectedDatasetId(value);
        setLlmContext({});
      }}
      viewColumns={selectedView?.columns || []}
    />
  );

  if (initialSection === "config") {
    return (
      <div className="bg-background">
        <main className="container py-6 space-y-6">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
                <KeyRound className="h-5 w-5 text-accent" />
                Configuracao LLM
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Gerencie a integracao do Insights com o provedor de LLM.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => navigate("/insights")}>
              <MessageSquare className="h-4 w-4 mr-1.5" />
              Abrir Insights
            </Button>
          </motion.div>

          {!isAdmin ? (
            <div className="glass-card p-6 max-w-xl">
              <p className="text-sm font-semibold text-foreground">Acesso restrito</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Somente administradores podem alterar a configuracao da LLM.
              </p>
            </div>
          ) : (
            <div className="glass-card p-6 max-w-3xl space-y-6">
              <div>
                <h2 className="text-base font-semibold text-foreground">Integracao OpenAI</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Cadastre a chave da OpenAI. A chave e armazenada de forma criptografada e nao e exibida apos salvar.
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="openai-model-page">Modelo</Label>
                  <Input id="openai-model-page" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini" />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="openai-key-page">OpenAI API Key</Label>
                  <Input
                    id="openai-key-page"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-..."
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    Chave salva: {integrationQuery.data?.masked_api_key || "nenhuma"}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => testIntegrationMutation.mutate()}
                  disabled={testIntegrationMutation.isPending}
                >
                  {testIntegrationMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Testar conexao
                </Button>
                <Button
                  onClick={() => saveIntegrationMutation.mutate()}
                  disabled={!apiKey.trim() || saveIntegrationMutation.isPending}
                >
                  {saveIntegrationMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Salvar
                </Button>
              </div>
            </div>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="bg-background h-[calc(100vh-3.5rem)] overflow-hidden">
      <main className="container h-full py-6 flex flex-col gap-4 overflow-hidden">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-3 shrink-0"
        >
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
                <MessageSquare className="h-5 w-5 text-accent" />
                Insights
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Faça perguntas em linguagem natural sobre os datasets.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold",
                      llmConfigured ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive",
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", llmConfigured ? "bg-success" : "bg-destructive")} />
                    {llmConfigured ? "LLM configurada" : "LLM nao configurada"}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {llmConfigured ? "Integracao OpenAI ativa" : "Configure a chave OpenAI para habilitar o chat"}
                </TooltipContent>
              </Tooltip>

              {isAdmin && (
                <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => navigate("/insights/config")}>
                  <KeyRound className="h-3.5 w-3.5" /> Configurar LLM
                </Button>
              )}
            </div>
          </div>
        </motion.div>

        {!llmConfigured && (
          <div className="rounded-lg border border-warning/30 bg-warning/5 text-warning px-3 py-2 text-xs flex items-center gap-2 shrink-0">
            <AlertCircle className="h-3.5 w-3.5" />
            Insights bloqueado: configure uma chave OpenAI para habilitar envio de perguntas.
          </div>
        )}

        <div className="grid flex-1 min-h-0 gap-6 grid-cols-[320px_minmax(0,1fr)]">
          <aside className="glass-card overflow-hidden h-full min-h-0">
            {sidePanelBody}
          </aside>

          <div className="glass-card overflow-hidden h-full min-h-0 relative">
            <ScrollArea className="h-full">
              <div className="p-6 pb-28">
                {!selectedDatasetId ? (
                  <div className="flex flex-col items-center justify-center min-h-[420px] gap-4 px-4">
                    <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/10">
                      <Database className="h-8 w-8 text-accent" />
                    </motion.div>
                    <div className="text-center max-w-md">
                      <h2 className="text-lg font-bold text-foreground mb-1">Selecione um Dataset</h2>
                      <p className="text-sm text-muted-foreground">
                        Escolha um dataset no painel da esquerda para iniciar perguntas em linguagem natural.
                      </p>
                    </div>
                  </div>
                ) : messages.length === 0 && !processing ? (
                  <div className="flex flex-col items-center justify-center min-h-[420px] gap-6 px-4">
                    <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/10">
                      <Sparkles className="h-8 w-8 text-accent" />
                    </motion.div>
                    <div className="text-center max-w-md">
                      <h2 className="text-lg font-bold text-foreground mb-1">Pronto para explorar</h2>
                      <p className="text-sm text-muted-foreground mb-4">
                        Pergunte sobre o dataset <span className="font-semibold text-foreground">{selectedDataset?.name}</span>.
                      </p>
                    </div>
                    <div className="flex flex-wrap justify-center gap-2 max-w-lg">
                      {suggestions.map((suggestion) => (
                        <button
                          key={suggestion}
                          onClick={() => {
                            setInputValue(suggestion);
                            inputRef.current?.focus();
                          }}
                          className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-colors"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="mx-auto w-full max-w-3xl space-y-6">
                    <AnimatePresence>
                      {messages.map((msg) => (
                        <MessageBubble key={msg.id} message={msg} />
                      ))}
                    </AnimatePresence>
                    {processing && <ProcessingIndicator step={processing} steps={[processing]} />}
                    <div ref={endRef} />
                  </div>
                )}
              </div>
            </ScrollArea>

            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card via-card/95 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 border-t border-border bg-card/95 backdrop-blur px-4 py-3">
              <div className="mx-auto w-full max-w-3xl flex gap-2">
                <Input
                  ref={inputRef}
                  placeholder={selectedDatasetId ? "Pergunte algo sobre seus dados..." : "Selecione um dataset primeiro"}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSend()}
                  disabled={!selectedDatasetId || !llmConfigured || !!processing || askMutation.isPending || integrationQuery.isLoading}
                  className="flex-1"
                />
                <Button
                  size="icon"
                  onClick={handleSend}
                  disabled={!selectedDatasetId || !inputValue.trim() || !llmConfigured || !!processing || askMutation.isPending || integrationQuery.isLoading}
                  className="shrink-0"
                >
                  {processing || askMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default InsightsPage;
