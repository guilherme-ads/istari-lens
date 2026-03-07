import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Bot, Check, Hash, LineChart, Loader2, Sparkles, Table2, BarChart3, PieChart, Wand2, ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { createDefaultWidgetConfig, type DashboardSection, type DashboardWidget, type WidgetType } from "@/types/dashboard";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

type SemanticColumn = { name: string; type: string };
type SetupStep = "config" | "generating" | "preview";

const quickPrompts = [
  "Dashboard completo de visao geral",
  "KPIs com indicadores principais",
  "Evolucao temporal e tabela detalhada",
  "Ranking por categoria com comparativos",
];

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
    explanationParts.push("Criei uma secao de visao geral com KPIs principais.");
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
    explanationParts.push(`Adicionei analise temporal usando a coluna ${temporal[0].name}.`);
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
    explanationParts.push(`Inclui comparativos por categoria usando ${categorical[0].name}.`);
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
    explanationParts.push("Adicionei tabela para investigacao detalhada.");
  }

  if (sections.length === 0) {
    sections.push({
      id: makeSectionId(),
      title: "Visao Geral",
      showTitle: true,
      columns: 2,
      widgets: [],
    });
    explanationParts.push("Nao identifiquei combinacoes seguras para autogerar widgets. Mantive estrutura inicial.");
  }

  return {
    sections,
    explanation: explanationParts.join(" "),
  };
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
  onStart: (title: string, sections: DashboardSection[]) => void;
}) => {
  const { toast } = useToast();
  const [title, setTitle] = useState(initialTitle || "Novo Dashboard");
  const [aiMode, setAiMode] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [step, setStep] = useState<SetupStep>("config");
  const [generatedSections, setGeneratedSections] = useState<DashboardSection[]>([]);
  const [generatedExplanation, setGeneratedExplanation] = useState("");
  const integrationQuery = useQuery({
    queryKey: ["api-config", "integration-status"],
    queryFn: () => api.getApiIntegration(),
    staleTime: 60_000,
    retry: false,
  });
  const aiAvailable = !!integrationQuery.data?.configured;

  const normalizedTitle = useMemo(() => (title.trim() || "Novo Dashboard"), [title]);
  useEffect(() => {
    if (!aiAvailable && aiMode) {
      setAiMode(false);
    }
  }, [aiAvailable, aiMode]);

  const handleStartWithoutAi = () => {
    onStart(normalizedTitle, [{
      id: makeSectionId(),
      title: "Visao Geral",
      showTitle: true,
      columns: 2,
      widgets: [],
    }]);
  };

  const handleGenerate = async () => {
    if (!aiAvailable) {
      toast({
        title: "Modo IA indisponivel",
        description: "Configure e valide uma chave OpenAI ativa em Configuracoes de API.",
        variant: "destructive",
      });
      return;
    }
    setStep("generating");
    try {
      const aiResult = await api.generateDashboardWithAi({
        dataset_id: datasetId,
        prompt,
        title: normalizedTitle,
      });
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
          config: widget.config as DashboardWidget["config"],
        })),
      }));
      setGeneratedSections(mappedSections);
      setGeneratedExplanation(aiResult.explanation || "Estrutura gerada com IA.");
      setStep("preview");
    } catch (error) {
      const message = error instanceof ApiError ? String(error.detail || error.message) : "Falha ao gerar com IA.";
      toast({ title: "Erro na geracao IA", description: message, variant: "destructive" });
      const fallback = generateDashboardFallback({
        prompt,
        columns,
        viewName,
      });
      setGeneratedSections(fallback.sections);
      setGeneratedExplanation(fallback.explanation);
      setStep("preview");
    }
  };

  return (
    <div className="container max-w-4xl py-6 space-y-6">
      <div>
        <h1 className="text-display text-foreground">Novo Dashboard</h1>
        <p className="text-body mt-1.5 text-muted-foreground">
          Complete o setup inicial para abrir o editor com estrutura consistente.
        </p>
      </div>

      {step === "config" && (
        <motion.div initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} className="space-y-4">
          <div className="glass-card p-6 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-heading">Nome do dashboard</Label>
              <Input
                id="dashboard-setup-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Novo Dashboard"
              />
            </div>
            <div className="text-xs text-muted-foreground">
              Dataset base: <span className="font-medium text-foreground">{viewName}</span> - {columns.length} colunas
            </div>
          </div>

          <div className="glass-card p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1.5">
                <Label className="text-heading">Modo IA (opcional)</Label>
                <p className="text-xs text-muted-foreground">
                  A IA monta seccoes e widgets com base no seu objetivo.
                  {!aiAvailable && " Configure uma chave OpenAI ativa para habilitar."}
                </p>
              </div>
              <Switch checked={aiMode} onCheckedChange={setAiMode} disabled={!aiAvailable} />
            </div>

            {aiMode && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-3"
              >
                <Textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Ex: Quero um dashboard com KPIs de receita, evolucao mensal e ranking por categoria."
                  className="min-h-[120px]"
                />
                <div className="flex flex-wrap gap-2">
                  {quickPrompts.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      onClick={() => setPrompt(chip)}
                      className="rounded-full border border-border px-3 py-1 text-xs hover:bg-accent/10"
                    >
                      {chip}
                    </button>
                  ))}
                </div>
              </motion.div>
            )}
          </div>

          <div className="flex items-center justify-end">
            {!aiMode ? (
              <Button onClick={handleStartWithoutAi} className="bg-accent text-accent-foreground hover:bg-accent/90">
                Comecar <ArrowRight className="h-4 w-4 ml-1.5" />
              </Button>
            ) : (
              <Button
                onClick={handleGenerate}
                className="bg-accent text-accent-foreground hover:bg-accent/90"
                disabled={!prompt.trim() || !aiAvailable || integrationQuery.isLoading}
              >
                <Wand2 className="h-4 w-4 mr-1.5" />
                {aiAvailable ? "Gerar Dashboard" : "Modo IA indisponivel"}
              </Button>
            )}
          </div>
        </motion.div>
      )}

      {step === "generating" && (
        <motion.div initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} className="glass-card p-12">
          <div className="flex flex-col items-center justify-center gap-3 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-accent" />
            <p className="text-sm font-medium">Gerando estrutura do dashboard...</p>
            <p className="text-xs text-muted-foreground">Analisando colunas e interpretando o prompt.</p>
          </div>
        </motion.div>
      )}

      {step === "preview" && (
        <motion.div initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} className="space-y-4">
          <div className="glass-card p-6 space-y-2">
            <h2 className="text-title flex items-center gap-2"><Bot className="h-5 w-5 text-accent" /> Preview do dashboard gerado</h2>
            <p className="text-body text-muted-foreground">{generatedExplanation}</p>
          </div>

          <div className="glass-card p-6 space-y-3">
            <div className="space-y-3">
              {generatedSections.map((section) => (
                <div key={section.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">{section.title}</p>
                    <Badge variant="secondary">{section.widgets.length} widgets</Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {section.widgets.map((widget) => {
                      const Icon = widgetIconByType[widget.config.widget_type];
                      return (
                        <span key={widget.id} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-xs">
                          <Icon className="h-3.5 w-3.5" />
                          {widget.title}
                        </span>
                      );
                    })}
                    {section.widgets.length === 0 && (
                      <span className="text-xs text-muted-foreground">Secao criada sem widgets.</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" onClick={() => setStep("config")}>
              Refazer
            </Button>
            <Button onClick={() => onStart(normalizedTitle, generatedSections)} className="bg-accent text-accent-foreground hover:bg-accent/90">
              <Sparkles className="h-4 w-4 mr-1.5" /> Criar Dashboard
            </Button>
          </div>
        </motion.div>
      )}
    </div>
  );
};

const StepBadge = ({ index, current, label }: { index: number; current: number; label: string }) => {
  const active = current === index;
  const done = current > index;
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 ${
        active ? "border-accent/30 bg-accent/10 text-accent" : done ? "border-success/30 bg-success/10 text-success" : "border-border text-muted-foreground"
      }`}
    >
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-xs font-bold">
        {done ? <Check className="h-3 w-3" /> : index + 1}
      </span>
      <span className="text-xs sm:text-sm font-medium">{label}</span>
    </span>
  );
};

export default DashboardSetup;

