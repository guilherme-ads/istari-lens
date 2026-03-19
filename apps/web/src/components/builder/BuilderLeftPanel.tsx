import { motion } from "framer-motion";
import { type DragEvent as ReactDragEvent } from "react";
import {
  BarChart3,
  BarChartHorizontal,
  GripVertical,
  Hash,
  LayoutGrid,
  LineChart,
  PieChart,
  Table2,
  Sparkles,
  Wand2,
  Telescope,
  Layers3,
  BookMarked,
  Columns3,
  Type,
} from "lucide-react";
import type { VisualizationType } from "@/types";
import type { BuilderWidgetPresetKey, WidgetType } from "@/types/dashboard";
import { WIDGET_CATALOG } from "@/components/builder/widget-catalog";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export interface BuilderLeftPanelProps {
  onAddWidget: (type: VisualizationType, preferredWidgetType?: WidgetType, presetKey?: BuilderWidgetPresetKey) => void;
  onGenerateWithAI: (mode: "widget" | "dashboard" | "explore") => void;
  collapsed?: boolean;
}

const NEW_WIDGET_DRAG_STATE_EVENT = "builder:new-widget-drag-state";

type WidgetOption = {
  type: VisualizationType;
  preferredWidgetType?: WidgetType;
  title: string;
  description: string;
  icon: typeof BarChart3;
};

const widgetIconsByWidgetType: Record<WidgetType, typeof BarChart3> = {
  kpi: Hash,
  bar: BarChartHorizontal,
  line: LineChart,
  donut: PieChart,
  table: Table2,
  column: BarChart3,
  text: Type,
  dre: Columns3,
};

const widgetOptions: WidgetOption[] = WIDGET_CATALOG.map((entry) => ({
  type: entry.visualizationType,
  preferredWidgetType: entry.widgetType,
  title: entry.title,
  description: entry.description,
  icon: widgetIconsByWidgetType[entry.widgetType] || LayoutGrid,
}));

const emitNewWidgetDragState = (
  active: boolean,
  payload?: { widgetType: VisualizationType; preferredWidgetType?: WidgetType; presetKey?: BuilderWidgetPresetKey },
) => {
  window.dispatchEvent(new CustomEvent(NEW_WIDGET_DRAG_STATE_EVENT, {
    detail: active
      ? {
          active: true,
          payload: {
            kind: "new-widget",
            widgetType: payload?.widgetType,
            preferredWidgetType: payload?.preferredWidgetType,
            presetKey: payload?.presetKey,
          },
        }
      : { active: false },
  }));
};

const patternOptions: Array<{
  title: string;
  description: string;
  type: VisualizationType;
  preferredWidgetType?: WidgetType;
  presetKey: BuilderWidgetPresetKey;
  icon: typeof BarChart3;
}> = [
  { title: "Metrica Unica", description: "KPI principal para leitura rapida", type: "kpi", presetKey: "kpi_primary", icon: Hash },
  { title: "KPI com Tendencia", description: "KPI com variacao do periodo anterior", type: "kpi", presetKey: "kpi_trend", icon: LineChart },
  { title: "Comparacao por Categoria", description: "Compara categorias por valor", type: "bar", presetKey: "category_comparison", icon: BarChartHorizontal },
  { title: "Top 10 Ranking", description: "Ordena e limita para principais categorias", type: "bar", presetKey: "top_10_ranking", icon: BarChartHorizontal },
  { title: "Evolucao Mensal", description: "Serie temporal em granularidade mensal", type: "line", presetKey: "temporal_evolution_monthly", icon: LineChart },
  { title: "Participacao Percentual", description: "Distribuicao percentual por categoria", type: "pie", presetKey: "share_distribution", icon: PieChart },
  { title: "Composicao no Tempo", description: "Colunas por mes para acompanhar composicao", type: "column", presetKey: "temporal_composition", icon: Layers3 },
  { title: "Tabela Detalhada", description: "Mais colunas e pagina maior para exploracao", type: "table", presetKey: "detailed_table", icon: Table2 },
];

const DraggableItem = ({
  icon: Icon,
  title,
  description,
  type,
  preferredWidgetType,
  presetKey,
  tourTarget,
  onClick,
}: {
  icon: typeof BarChart3;
  title: string;
  description: string;
  type: VisualizationType;
  preferredWidgetType?: WidgetType;
  presetKey?: BuilderWidgetPresetKey;
  tourTarget?: string;
  onClick: () => void;
}) => (
  <motion.button
    type="button"
    data-tour={tourTarget}
    draggable
    onClick={onClick}
    onDragStartCapture={(event: ReactDragEvent<HTMLButtonElement>) => {
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("application/x-istari-builder-dnd", JSON.stringify({
        kind: "new-widget",
        widgetType: type,
        preferredWidgetType,
        presetKey,
      }));
      event.dataTransfer.setData("text/plain", title);
      emitNewWidgetDragState(true, { widgetType: type, preferredWidgetType, presetKey });
    }}
    onDragEndCapture={() => {
      emitNewWidgetDragState(false);
    }}
    whileHover={{ scale: 1.01, x: 2 }}
    className={cn(
      "group w-full rounded-lg border border-border/50 bg-card/50 px-3 py-2.5 text-left",
      "transition-colors hover:bg-muted/50 hover:border-accent/30",
    )}
  >
    <div className="flex items-start gap-2.5">
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/10">
        <Icon className="h-4 w-4 text-accent" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-foreground whitespace-normal break-words leading-4">{title}</p>
        <p className="text-[10px] text-muted-foreground whitespace-normal break-words leading-4">{description}</p>
      </div>
      <GripVertical className="mt-0.5 h-3.5 w-3.5 text-muted-foreground/30 transition-colors group-hover:text-muted-foreground/80" />
    </div>
  </motion.button>
);

const IconOnlyDraggableItem = ({
  icon: Icon,
  title,
  type,
  preferredWidgetType,
  presetKey,
  tourTarget,
  onClick,
}: {
  icon: typeof BarChart3;
  title: string;
  type: VisualizationType;
  preferredWidgetType?: WidgetType;
  presetKey?: BuilderWidgetPresetKey;
  tourTarget?: string;
  onClick: () => void;
}) => (
  <motion.button
    type="button"
    data-tour={tourTarget}
    title={title}
    draggable
    onClick={onClick}
    onDragStartCapture={(event: ReactDragEvent<HTMLButtonElement>) => {
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("application/x-istari-builder-dnd", JSON.stringify({
        kind: "new-widget",
        widgetType: type,
        preferredWidgetType,
        presetKey,
      }));
      event.dataTransfer.setData("text/plain", title);
      emitNewWidgetDragState(true, { widgetType: type, preferredWidgetType, presetKey });
    }}
    onDragEndCapture={() => {
      emitNewWidgetDragState(false);
    }}
    whileHover={{ scale: 1.03 }}
    className={cn(
      "group flex h-10 w-10 items-center justify-center rounded-lg border border-border/50 bg-card/50",
      "transition-colors hover:bg-muted/50 hover:border-accent/30",
    )}
  >
    <Icon className="h-4 w-4 text-accent" />
    <span className="sr-only">{title}</span>
  </motion.button>
);

const AIAction = ({
  icon: Icon,
  title,
  description,
  accent = false,
  onClick,
}: {
  icon: typeof Sparkles;
  title: string;
  description: string;
  accent?: boolean;
  onClick: () => void;
}) => (
  <motion.button
    type="button"
    onClick={onClick}
    whileHover={{ scale: 1.01, x: 2 }}
    className={cn(
      "group w-full rounded-lg border px-3 py-2.5 text-left transition-colors",
      accent ? "border-accent/30 bg-accent/5 hover:bg-accent/10" : "border-border/50 bg-card/50 hover:bg-muted/50 hover:border-accent/30",
    )}
  >
    <div className="flex items-start gap-2.5">
      <span className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md", accent ? "bg-accent/15" : "bg-accent/10")}>
        <Icon className={cn("h-4 w-4", accent ? "text-accent" : "text-accent")} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold whitespace-normal break-words leading-4">{title}</p>
        <p className="text-[10px] text-muted-foreground whitespace-normal break-words leading-4">{description}</p>
      </div>
    </div>
  </motion.button>
);

export const BuilderLeftPanel = ({ onAddWidget, onGenerateWithAI, collapsed = false }: BuilderLeftPanelProps) => {
  if (collapsed) {
    return (
      <aside className="h-full border-r border-border/50 bg-card/30 overflow-hidden flex flex-col">
        <ScrollArea className="h-full px-2 py-3">
          <div className="flex flex-col items-center gap-2">
            {widgetOptions.map((option, index) => (
              <IconOnlyDraggableItem
                key={`icon-${option.title}-${index}`}
                icon={option.icon}
                title={option.title}
                type={option.type}
                preferredWidgetType={option.preferredWidgetType}
                tourTarget={index === 0 ? "builder-widget-source" : undefined}
                onClick={() => onAddWidget(option.type, option.preferredWidgetType)}
              />
            ))}
          </div>
        </ScrollArea>
      </aside>
    );
  }

  return (
    <aside className="h-full border-r border-border/50 bg-card/30 overflow-hidden flex flex-col">
      <Tabs defaultValue="widgets" className="h-full flex flex-col overflow-hidden">
        <div className="px-3 pt-3 pb-2">
          <TabsList className="grid h-8 w-full grid-cols-3 rounded-lg bg-muted/30 p-0.5">
            <TabsTrigger value="widgets" className="h-7 rounded-md text-[10px] font-semibold">Widgets</TabsTrigger>
            <TabsTrigger value="padroes" className="h-7 rounded-md text-[10px] font-semibold">Padroes</TabsTrigger>
            <TabsTrigger value="ia" className="h-7 rounded-md text-[10px] font-semibold">IA</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="widgets" className="m-0 min-h-0 flex-1">
          <ScrollArea className="h-full px-3 pb-3">
            <div className="space-y-1.5">
              {widgetOptions.map((option, index) => (
                <DraggableItem
                  key={`${option.title}-${index}`}
                  icon={option.icon}
                  title={option.title}
                  description={option.description}
                  type={option.type}
                  preferredWidgetType={option.preferredWidgetType}
                  tourTarget={index === 0 ? "builder-widget-source" : undefined}
                  onClick={() => onAddWidget(option.type, option.preferredWidgetType)}
                />
              ))}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="padroes" className="m-0 min-h-0 flex-1">
          <ScrollArea className="h-full px-3 pb-3">
            <div className="space-y-1.5">
              {patternOptions.map((pattern) => (
                <DraggableItem
                  key={pattern.title}
                  icon={pattern.icon}
                  title={pattern.title}
                  description={pattern.description}
                  type={pattern.type}
                  preferredWidgetType={pattern.preferredWidgetType}
                  presetKey={pattern.presetKey}
                  onClick={() => onAddWidget(pattern.type, pattern.preferredWidgetType, pattern.presetKey)}
                />
              ))}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="ia" className="m-0 min-h-0 flex-1">
          <ScrollArea className="h-full px-3 pb-3">
            <div className="space-y-2">
              <AIAction
                icon={Wand2}
                title="Gerar Widget"
                description="Cria um widget a partir do contexto do dataset"
                accent
                onClick={() => onGenerateWithAI("widget")}
              />
              <AIAction
                icon={Sparkles}
                title="Gerar Dashboard"
                description="Monta uma estrutura inicial de secoes e widgets"
                accent
                onClick={() => onGenerateWithAI("dashboard")}
              />
              <AIAction
                icon={Telescope}
                title="Explorar Dataset"
                description="Sugestoes de perguntas e exploracao guiada"
                onClick={() => onGenerateWithAI("explore")}
              />
            </div>

            <Separator className="my-3" />

            <div>
              <p className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold">
                <BookMarked className="h-3 w-3" /> Biblioteca
              </p>
              <div className="rounded-lg border border-dashed border-border/60 p-4 text-[10px] text-muted-foreground">
                Widgets salvos aparecerao aqui.
              </div>
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </aside>
  );
};

export default BuilderLeftPanel;
