import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, BarChart3, ChevronDown, ChevronUp, ExternalLink, Hash, Layers3, LayoutDashboard, LineChart, Lock, PieChart, Sparkles, Table2, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ChatInput, ChatMessages, ChatSuggestions, type ChatMessageData } from "@/components/shared/Chat";
import { createDefaultWidgetConfig, type DashboardSection, type DashboardWidget, type WidgetType } from "@/types/dashboard";
import { api, ApiError, type ApiDashboardNativeFilter } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

type SemanticColumn = { name: string; type: string };
type CreationFlowState = "mode_selection" | "ai_creation" | "dashboard_preview";
type CreationSource = "ai" | "manual";
type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  kind?: "thinking";
};

const quickPrompts = [
  "Dashboard completo de visao geral",
  "KPIs com indicadores principais",
  "Evolucao temporal e tabela detalhada",
  "Ranking por categoria com comparativos",
];

const generationThinkingSteps = [
  "Mapeando colunas e contexto do dataset",
  "Organizando narrativa analítica em seções",
  "Criando widgets e configurações iniciais",
  "Finalizando estrutura do dashboard"
];

const sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

const randomBetween = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

const waitStepPause = async (params: {
  normalMs: number;
  minimumMs: number;
  isResponseReady: () => boolean;
}) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.normalMs) {
    if (params.isResponseReady() && Date.now() - startedAt >= params.minimumMs) {
      return;
    }
    await sleep(60);
  }
};

const splitPlanningSteps = (value: string) => (
  value
    .split(".")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/[;:]$/, ""))
);

const normalizeSemanticType = (rawType: string): "numeric" | "temporal" | "text" | "boolean" => {
  const value = (rawType || "").toLowerCase();
  if (value === "numeric" || value === "temporal" || value === "text" || value === "boolean") return value;
  if (["int", "numeric", "decimal", "real", "double", "float", "money"].some((token) => value.includes(token))) return "numeric";
  if (["date", "time", "timestamp"].some((token) => value.includes(token))) return "temporal";
  if (value.includes("bool")) return "boolean";
  return "text";
};

const makeSectionId = () => `sec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const makeWidgetId = () => `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const makeMessageId = () => `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const createWidget = (params: {
  type: WidgetType;
  title: string;
  position: number;
  columns: SemanticColumn[];
  viewName: string;
  width?: 1 | 2 | 3 | 4;
  height?: 0.5 | 1 | 2;
}): DashboardWidget => {
  const config = createDefaultWidgetConfig({ type: params.type, viewName: params.viewName, columns: params.columns });
  return {
    id: makeWidgetId(),
    title: params.title,
    position: params.position,
    configVersion: 1,
    config: {
      ...config,
      size: {
        width: params.width || config.size?.width || 1,
        height: params.height || config.size?.height || 1,
      },
    },
  };
};

const widgetIconByType: Record<WidgetType, typeof Hash> = {
  kpi: Hash,
  line: LineChart,
  bar: BarChart3,
  column: BarChart3,
  donut: PieChart,
  table: Table2,
  text: Sparkles,
  dre: Table2,
};

const generateDashboardFallback = (params: { prompt: string; columns: SemanticColumn[]; viewName: string }) => {
  const prompt = params.prompt.trim().toLowerCase();
  const numeric = params.columns.filter((column) => normalizeSemanticType(column.type) === "numeric");
  const temporal = params.columns.filter((column) => normalizeSemanticType(column.type) === "temporal");
  const categorical = params.columns.filter((column) => {
    const semantic = normalizeSemanticType(column.type);
    return semantic === "text" || semantic === "boolean";
  });

  const defaultAll = !prompt;
  const wantsKpi = defaultAll || /kpi|indicador|resumo|visao geral|painel executivo|meta/.test(prompt);
  const wantsTrend = defaultAll || /tendencia|evolucao|historico|tempo|mensal|diario|linha/.test(prompt);
  const wantsCategory = defaultAll || /categoria|ranking|top|segmento|canal|composicao|comparativo|barra|rosca|donut/.test(prompt);
  const wantsTable = defaultAll || /tabela|detalhe|listagem|registro/.test(prompt);

  const sections: DashboardSection[] = [];
  const explanationParts: string[] = [];

  if (wantsKpi) {
    const kpiWidgets: DashboardWidget[] = [];
    const metricColumns = numeric.length > 0 ? numeric.slice(0, 4) : [];
    if (metricColumns.length > 0) {
      metricColumns.forEach((column, index) => {
        const widget = createWidget({
          type: "kpi",
          title: `KPI . ${column.name}`,
          position: index,
          columns: params.columns,
          viewName: params.viewName,
        });
        widget.config.metrics = [{ op: "sum", column: column.name }];
        kpiWidgets.push(widget);
      });
    } else {
      kpiWidgets.push(createWidget({
        type: "kpi",
        title: "KPI . Total de registros",
        position: 0,
        columns: params.columns,
        viewName: params.viewName,
      }));
    }
    sections.push({
      id: makeSectionId(),
      title: "Visao Geral",
      showTitle: true,
      columns: 4,
      widgets: kpiWidgets,
    });
    explanationParts.push("Criei uma secao de visao geral com KPIs principais");
  }

  if (wantsTrend && temporal.length > 0) {
    const trendWidget = createWidget({
      type: "line",
      title: "Evolucao temporal",
      position: 0,
      columns: params.columns,
      viewName: params.viewName,
      width: 4,
      height: 2,
    });
    if (numeric[0]) {
      trendWidget.config.metrics = [{ op: "sum", column: numeric[0].name, line_y_axis: "left" }];
    }
    trendWidget.config.time = { column: temporal[0].name, granularity: "month" };
    sections.push({
      id: makeSectionId(),
      title: "Tendencia",
      showTitle: true,
      columns: 4,
      widgets: [trendWidget],
    });
    explanationParts.push(`Adicionei analise temporal usando a coluna ${temporal[0].name}`);
  }

  if (wantsCategory && categorical.length > 0) {
    const barWidget = createWidget({
      type: "bar",
      title: `Ranking por ${categorical[0].name}`,
      position: 0,
      columns: params.columns,
      viewName: params.viewName,
      width: 2,
      height: 2,
    });
    barWidget.config.dimensions = [categorical[0].name];
    if (numeric[0]) {
      barWidget.config.metrics = [{ op: "sum", column: numeric[0].name }];
    }

    const donutWidget = createWidget({
      type: "donut",
      title: `Composicao por ${categorical[0].name}`,
      position: 1,
      columns: params.columns,
      viewName: params.viewName,
      width: 2,
      height: 2,
    });
    donutWidget.config.dimensions = [categorical[0].name];
    donutWidget.config.metrics = [{ op: numeric[1] ? "sum" : "count", column: numeric[1]?.name }];

    sections.push({
      id: makeSectionId(),
      title: "Composicao e Ranking",
      showTitle: true,
      columns: 2,
      widgets: [barWidget, donutWidget],
    });
    explanationParts.push(`Inclui comparativos por categoria usando ${categorical[0].name}`);
  }

  if (wantsTable) {
    const tableWidget = createWidget({
      type: "table",
      title: "Detalhamento",
      position: 0,
      columns: params.columns,
      viewName: params.viewName,
      width: 4,
      height: 2,
    });
    tableWidget.config.columns = params.columns.slice(0, Math.min(8, params.columns.length)).map((item) => item.name);
    sections.push({
      id: makeSectionId(),
      title: "Detalhamento",
      showTitle: true,
      columns: 4,
      widgets: [tableWidget],
    });
    explanationParts.push("Adicionei tabela para investigacao detalhada");
  }

  if (sections.length === 0) {
    sections.push({
      id: makeSectionId(),
      title: "Visao Geral",
      showTitle: true,
      columns: 2,
      widgets: [],
    });
    explanationParts.push("Nao identifiquei combinacoes seguras para autogerar widgets");
  }

  return {
    sections,
    explanation: explanationParts.join(". "),
    planningSteps: explanationParts,
  };
};

const createManualSections = (): DashboardSection[] => [{
  id: makeSectionId(),
  title: "Visao Geral",
  showTitle: true,
  columns: 2,
  widgets: [],
}];

const DatasetContext = ({ viewName, fieldCount }: { viewName: string; fieldCount: number }) => (
  <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
    <p className="text-xs text-muted-foreground">
      Dataset: <span className="font-medium text-foreground">{viewName}</span>
    </p>
    <p className="mt-0.5 text-xs text-muted-foreground">{fieldCount} campos disponiveis</p>
  </div>
);

const DashboardCreationMode = ({
  aiAvailable,
  isCheckingAi,
  onSelectManual,
  onSelectAi,
  onGoApiConfig,
}: {
  aiAvailable: boolean;
  isCheckingAi: boolean;
  onSelectManual: () => void;
  onSelectAi: () => void;
  onGoApiConfig: () => void;
}) => (
  <div className="grid gap-4 md:grid-cols-2">
    <button
      type="button"
      onClick={onSelectManual}
      className="glass-card p-6 text-left transition-colors hover:bg-muted/20"
    >
      <div className="flex items-center gap-2.5">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background/70 text-muted-foreground">
          <LayoutDashboard className="h-4 w-4" />
        </span>
        <div>
          <p className="text-sm font-semibold text-foreground">Comecar do zero</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Monte manualmente secoes e widgets.</p>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">Modo manual</span>
        <span className="inline-flex items-center gap-1 text-xs font-medium text-accent">
          Selecionar <ArrowRight className="h-3.5 w-3.5" />
        </span>
      </div>
    </button>

    <div className="glass-card p-6">
      <p className="text-sm font-semibold text-foreground">Criar com IA</p>
      <p className="mt-1 text-xs text-muted-foreground">Descreva seu objetivo e gere a estrutura automaticamente.</p>
      <div className={`mt-3 rounded-md border px-2.5 py-2 text-[11px] ${aiAvailable ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-border bg-muted/40 text-muted-foreground"}`}>
        <span className="inline-flex items-center gap-1.5">
          <Lock className="h-3.5 w-3.5" />
          {isCheckingAi ? "Validando integracao OpenAI..." : aiAvailable ? "OpenAI pronta para uso" : "OpenAI nao configurada"}
        </span>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Button
          onClick={onSelectAi}
          className="h-10 gap-2 px-4 text-sm bg-accent text-accent-foreground hover:bg-accent/90"
        >
          <Wand2 className="mr-1.5 h-4 w-4" />
          Criar com IA
          <Sparkles className="h-4 w-4" />
        </Button>

        {!aiAvailable && (
          <Button type="button" variant="outline" onClick={onGoApiConfig}>
            Configurar IA <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  </div>
);

const AIDashboardCreator = ({
  chatMessages,
  chatInput,
  isGenerating,
  onChangeInput,
  onSubmitPrompt,
  onUseSuggestion,
  canGenerateDashboard,
  onGenerateDashboard,
  generatedSections,
}: {
  chatMessages: ChatMessage[];
  chatInput: string;
  isGenerating: boolean;
  onChangeInput: (value: string) => void;
  onSubmitPrompt: () => void;
  onUseSuggestion: (value: string) => void;
  canGenerateDashboard: boolean;
  onGenerateDashboard: () => void;
  generatedSections: DashboardSection[];
}) => {
  const mappedMessages = useMemo<ChatMessageData[]>(() => chatMessages.map((message) => ({
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    content: message.text,
    status: message.kind === "thinking" && !message.text ? "thinking" : undefined,
  })), [chatMessages]);
  const hasUserMessages = chatMessages.some((message) => message.role === "user");
  const generatedWidgetCount = generatedSections.reduce((acc, section) => acc + section.widgets.length, 0);

  return (
    <div className="glass-card flex h-[calc(100vh-185px)] min-h-[500px] max-h-[780px] flex-col overflow-hidden">
      <ChatMessages
        messages={mappedMessages}
        isTyping={isGenerating}
        className="bg-gradient-to-b from-background to-muted/20"
      >
        {!hasUserMessages && (
          <div className="max-w-[85%] rounded-2xl border border-border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">Sugestoes:</p>
            <ChatSuggestions
              suggestions={quickPrompts}
              onSelect={onUseSuggestion}
              className="mt-2"
            />
          </div>
        )}

        {canGenerateDashboard && generatedSections.length > 0 && (
          <div className="w-full max-w-[92%] rounded-3xl border border-border bg-card/95 px-5 py-4 shadow-sm">
            <p className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
              <Layers3 className="h-4 w-4" />
              {generatedSections.length} secoes - {generatedWidgetCount} widgets
            </p>
            <div className="mt-3 border-t border-border/70" />
            <div className="mt-4 space-y-4">
              {generatedSections.map((section) => (
                <div key={section.id} className="space-y-2.5">
                  <p className="text-lg font-semibold text-foreground">{section.title}</p>
                  <div className="flex flex-wrap gap-2">
                    {section.widgets.map((widget) => {
                      const Icon = widgetIconByType[widget.config.widget_type];
                      return (
                        <span key={widget.id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 text-sm text-muted-foreground">
                          <Icon className="h-3.5 w-3.5" />
                          {widget.title}
                        </span>
                      );
                    })}
                    {section.widgets.length === 0 && (
                      <span className="text-xs text-muted-foreground">Secao sem widgets.</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </ChatMessages>
      <div className="border-t border-border/70 p-4">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2">
          <ChatInput
            value={chatInput}
            onChange={onChangeInput}
            onSend={onSubmitPrompt}
            disabled={isGenerating}
            placeholder="Descreva o dashboard que voce quer criar..."
            className="flex-1"
          />
          {canGenerateDashboard && (
            <Button onClick={onGenerateDashboard} disabled={isGenerating}>
              <Sparkles className="mr-1.5 h-4 w-4" />
              Gerar dashboard
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

const DashboardPreview = ({
  creationSource,
  title,
  onChangeTitle,
  sections,
  explanation,
  planningSteps,
  showReasoning,
  onToggleReasoning,
  onBack,
  onCreate,
}: {
  creationSource: CreationSource;
  title: string;
  onChangeTitle: (value: string) => void;
  sections: DashboardSection[];
  explanation: string;
  planningSteps: string[];
  showReasoning: boolean;
  onToggleReasoning: () => void;
  onBack: () => void;
  onCreate: () => void;
}) => {
  const widgetCount = sections.reduce((acc, section) => acc + section.widgets.length, 0);

  return (
    <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
      <div className="space-y-4">
        <div className="glass-card p-6 space-y-3">
          <p className="text-title text-foreground">Preview do dashboard</p>
          <div className="space-y-1.5">
            <label htmlFor="dashboard-preview-title" className="text-xs font-medium text-muted-foreground">Nome do dashboard</label>
            <Input
              id="dashboard-preview-title"
              value={title}
              onChange={(event) => onChangeTitle(event.target.value)}
              placeholder="Novo Dashboard"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">{sections.length} secoes</Badge>
            <Badge variant="secondary">{widgetCount} widgets</Badge>
            <Badge variant="secondary">{creationSource === "ai" ? "Criado com IA" : "Criacao manual"}</Badge>
          </div>
        </div>

        <div className="glass-card p-6 space-y-3">
          <p className="text-sm font-semibold text-foreground">Estrutura gerada</p>
          <div className="space-y-3">
            {sections.map((section) => (
              <div key={section.id} className="rounded-lg border border-border/70 bg-background/70 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-foreground">{section.title}</p>
                  <Badge variant="secondary">{section.widgets.length} widgets</Badge>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {section.widgets.map((widget) => {
                    const Icon = widgetIconByType[widget.config.widget_type];
                    return (
                      <span key={widget.id} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">
                        <Icon className="h-3.5 w-3.5" />
                        {widget.title}
                      </span>
                    );
                  })}
                  {section.widgets.length === 0 && (
                    <span className="text-xs text-muted-foreground">Secao sem widgets.</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-4">
        {creationSource === "ai" && (
          <>
            <div className="glass-card p-6 space-y-2">
              <button
                type="button"
                onClick={onToggleReasoning}
                className="w-full flex items-center justify-between text-left"
              >
                <span className="text-sm font-semibold text-foreground">Como a IA pensou</span>
                {showReasoning ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
              </button>
              {showReasoning && (
                <p className="text-xs leading-5 text-muted-foreground">
                  {explanation || "Estrutura gerada com IA."}
                </p>
              )}
            </div>

            {planningSteps.length > 0 && (
              <div className="glass-card p-6 space-y-2">
                <p className="text-sm font-semibold text-foreground">Planning steps</p>
                <div className="space-y-1.5">
                  {planningSteps.map((stepItem, index) => (
                    <div key={`${stepItem}-${index}`} className="flex items-start gap-2 text-xs text-muted-foreground">
                      <span className="mt-0.5 inline-flex h-4.5 w-4.5 items-center justify-center rounded-full bg-accent/15 text-[10px] font-semibold text-accent">
                        {index + 1}
                      </span>
                      <p>{stepItem}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        <div className="glass-card p-6">
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={onBack}>
              <ArrowLeft className="mr-1.5 h-4 w-4" /> Voltar
            </Button>
            <Button onClick={onCreate}>
              <Sparkles className="mr-1.5 h-4 w-4" /> Novo dashboard
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

const DashboardSetup = ({
  columns,
  datasetId,
  viewName,
  initialTitle,
  onStart,
}: {
  columns: SemanticColumn[];
  datasetId: number;
  viewName: string;
  initialTitle?: string;
  onStart: (title: string, sections: DashboardSection[], nativeFilters?: ApiDashboardNativeFilter[]) => void;
}) => {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [flowState, setFlowState] = useState<CreationFlowState>("mode_selection");
  const [creationSource, setCreationSource] = useState<CreationSource>("manual");
  const [dashboardTitle, setDashboardTitle] = useState(initialTitle || "Novo Dashboard");
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [generatedSections, setGeneratedSections] = useState<DashboardSection[]>([]);
  const [generatedExplanation, setGeneratedExplanation] = useState("");
  const [generatedPlanningSteps, setGeneratedPlanningSteps] = useState<string[]>([]);
  const [generatedNativeFilters, setGeneratedNativeFilters] = useState<ApiDashboardNativeFilter[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showReasoning, setShowReasoning] = useState(true);

  const integrationQuery = useQuery({
    queryKey: ["api-config", "integration-status"],
    queryFn: () => api.getApiIntegration(),
    staleTime: 60_000,
    retry: false,
  });

  const aiAvailable = !!integrationQuery.data?.configured;

  const normalizedTitle = useMemo(() => (dashboardTitle.trim() || "Novo Dashboard"), [dashboardTitle]);
  const isAiCreation = flowState === "ai_creation";

  const resetGeneratedPayload = () => {
    setGeneratedSections([]);
    setGeneratedExplanation("");
    setGeneratedPlanningSteps([]);
    setGeneratedNativeFilters([]);
    setShowReasoning(true);
  };

  const typeAssistantMessage = async (text: string, kind?: "thinking") => {
    const id = makeMessageId();
    setChatMessages((current) => [...current, { id, role: "assistant", text: "", kind }]);

    let currentText = "";
    for (const char of text) {
      currentText += char;
      const nextText = currentText;
      setChatMessages((messages) => messages.map((message) => (
        message.id === id ? { ...message, text: nextText } : message
      )));
      await sleep(char === " " ? randomBetween(8, 18) : randomBetween(14, 28));
    }
  };

  const pushUserMessage = (text: string) => {
    setChatMessages((current) => [...current, { id: makeMessageId(), role: "user", text }]);
  };

  const buildAiPrompt = (draft: string) => {
    const history = chatMessages
      .filter((message) => message.role === "user")
      .map((message) => message.text.trim())
      .filter(Boolean);
    if (draft.trim()) history.push(draft.trim());
    return history.join("\n");
  };

  const enterAiCreation = () => {
    if (!aiAvailable) {
      toast({
        title: "Modo IA indisponivel",
        description: "Configure e valide uma chave OpenAI ativa em Configuracoes de API.",
        variant: "destructive",
      });
      return;
    }
    setFlowState("ai_creation");
    setCreationSource("ai");
    if (chatMessages.length === 0) {
      setChatMessages([]);
      void typeAssistantMessage(`Ola! Vou te ajudar a criar o dashboard "${normalizedTitle}". Estou analisando os dados de ${viewName} com ${columns.length} campos disponiveis. Descreva o que deseja visualizar.`);
    }
  };

  const handleSubmitPromptToAi = async () => {
    if (!aiAvailable) {
      toast({
        title: "Modo IA indisponivel",
        description: "Configure e valide uma chave OpenAI ativa em Configuracoes de API.",
        variant: "destructive",
      });
      return;
    }
    if (isGenerating) return;

    const draft = chatInput.trim();
    const finalPrompt = buildAiPrompt(draft);
    if (!finalPrompt.trim()) {
      toast({
        title: "Envie um briefing",
        description: "Descreva primeiro o que deseja no dashboard.",
        variant: "destructive",
      });
      return;
    }

    if (draft) {
      pushUserMessage(draft);
      setChatInput("");
    }

    setIsGenerating(true);
    resetGeneratedPayload();

    let aiResult: Awaited<ReturnType<typeof api.generateDashboardWithAi>> | null = null;
    let aiError: unknown = null;
    let responseReady = false;

    const requestPromise = (async () => {
      try {
        aiResult = await api.generateDashboardWithAi({
          dataset_id: datasetId,
          prompt: finalPrompt,
          title: normalizedTitle,
        });
      } catch (error) {
        aiError = error;
      } finally {
        responseReady = true;
      }
    })();

    for (const stepText of generationThinkingSteps) {
      await waitStepPause({
        normalMs: randomBetween(1200, 1800),
        minimumMs: 180,
        isResponseReady: () => responseReady,
      });
      await typeAssistantMessage(stepText, "thinking");
    }

    await requestPromise;

    if (aiError || !aiResult) {
      const message = aiError instanceof ApiError ? String(aiError.detail || aiError.message) : "Falha ao gerar com IA.";
      toast({ title: "Erro na geracao IA", description: message, variant: "destructive" });
      const fallback = generateDashboardFallback({
        prompt: finalPrompt,
        columns,
        viewName,
      });
      setGeneratedSections(fallback.sections);
      setGeneratedExplanation(fallback.explanation);
      setGeneratedPlanningSteps(fallback.planningSteps);
      await typeAssistantMessage("Tive um problema na geracao. Preparei uma estrutura segura para revisao.");
      setIsGenerating(false);
      return;
    }

    const mappedSections: DashboardSection[] = aiResult.sections.map((section) => ({
      id: section.id,
      title: section.title,
      showTitle: section.show_title,
      columns: section.columns,
      widgets: section.widgets.map((widget) => ({
        id: widget.id,
        title: widget.title,
        position: widget.position,
        configVersion: widget.config_version,
        config: widget.config as unknown as DashboardWidget["config"],
      })),
    }));
    setGeneratedSections(mappedSections);
    setGeneratedExplanation(aiResult.explanation || "Estrutura gerada com IA.");
    setGeneratedPlanningSteps((aiResult.planning_steps || []).filter((item) => typeof item === "string" && item.trim().length > 0));
    setGeneratedNativeFilters((aiResult.native_filters || []).map((item) => ({
      column: item.column,
      op: item.op,
      value: item.value,
      visible: typeof item.visible === "boolean" ? item.visible : true,
    })));
    await typeAssistantMessage(`Dashboard montado com ${mappedSections.length} secoes. Se estiver tudo certo, clique em "Gerar dashboard".`);
    setIsGenerating(false);
  };

  const handleCreateGeneratedDashboard = () => {
    if (generatedSections.length === 0) return;
    onStart(normalizedTitle, generatedSections, generatedNativeFilters);
  };

  const handleBackFromPreview = () => {
    setFlowState(creationSource === "ai" ? "ai_creation" : "mode_selection");
  };

  return (
    <div className={`container max-w-[1100px] ${isAiCreation ? "py-3 space-y-3" : "py-6 space-y-6"}`}>
      <div className={`rounded-2xl border border-accent/20 bg-gradient-to-br from-accent/10 via-background to-background shadow-sm ${isAiCreation ? "p-3 sm:p-4" : "p-6"}`}>
        {isAiCreation ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-lg font-semibold text-foreground">{normalizedTitle}</h1>
            <span className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-[11px] font-medium text-accent">
              <Wand2 className="h-3.5 w-3.5" />
              Modo IA
            </span>
          </div>
        ) : (
          <>
            <h1 className="text-display text-foreground">
              {flowState === "dashboard_preview" ? normalizedTitle : "Novo Dashboard"}
            </h1>
            <p className="mt-1.5 text-body text-muted-foreground">
              {flowState === "mode_selection"
                ? "Escolha como deseja iniciar."
                : "Revise a estrutura antes de abrir o builder."}
            </p>
          </>
        )}
      </div>

      {flowState === "mode_selection" && (
        <DatasetContext viewName={viewName} fieldCount={columns.length} />
      )}

      {flowState === "mode_selection" && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <DashboardCreationMode
            aiAvailable={aiAvailable}
            isCheckingAi={integrationQuery.isLoading}
            onSelectManual={() => {
              setCreationSource("manual");
              onStart(normalizedTitle, createManualSections());
            }}
            onSelectAi={enterAiCreation}
            onGoApiConfig={() => navigate("/api-config")}
          />
        </motion.div>
      )}

      {flowState === "ai_creation" && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <AIDashboardCreator
            chatMessages={chatMessages}
            chatInput={chatInput}
            isGenerating={isGenerating}
            onChangeInput={setChatInput}
            onSubmitPrompt={() => { void handleSubmitPromptToAi(); }}
            onUseSuggestion={setChatInput}
            canGenerateDashboard={generatedSections.length > 0 && !isGenerating}
            onGenerateDashboard={handleCreateGeneratedDashboard}
            generatedSections={generatedSections}
          />
        </motion.div>
      )}

      {flowState === "dashboard_preview" && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <DashboardPreview
            creationSource={creationSource}
            title={dashboardTitle}
            onChangeTitle={setDashboardTitle}
            sections={generatedSections}
            explanation={generatedExplanation}
            planningSteps={generatedPlanningSteps.length > 0 ? generatedPlanningSteps : splitPlanningSteps(generatedExplanation)}
            showReasoning={showReasoning}
            onToggleReasoning={() => setShowReasoning((current) => !current)}
            onBack={handleBackFromPreview}
            onCreate={() => onStart(normalizedTitle, generatedSections, generatedNativeFilters)}
          />
        </motion.div>
      )}
    </div>
  );
};


export default DashboardSetup;

