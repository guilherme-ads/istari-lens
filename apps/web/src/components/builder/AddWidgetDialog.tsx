import { useState } from "react";
import { motion } from "framer-motion";
import { BarChartHorizontal, LineChart, Table2, Hash, TextCursorInput, BarChart3, PieChart } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { WidgetType } from "@/types/dashboard";

const widgetTypes: { value: WidgetType; label: string; icon: typeof BarChartHorizontal; desc: string; whenToUse: string }[] = [
  { value: "kpi", label: "KPI", icon: Hash, desc: "Metrica agregada unica", whenToUse: "Quando quiser destacar um unico numero-chave (meta, total, média)." },
  { value: "bar", label: "Barra", icon: BarChartHorizontal, desc: "Categoria x metrica agregada", whenToUse: "Quando comparar poucas categorias em barras horizontais." },
  { value: "column", label: "Coluna", icon: BarChart3, desc: "Categoria x metrica agregada em barras verticais", whenToUse: "Quando comparar categorias em barras verticais." },
  { value: "donut", label: "Rosca", icon: PieChart, desc: "Distribuicao percentual por categoria", whenToUse: "Quando mostrar composicao/participação percentual entre categorias." },
  { value: "dre", label: "DRE", icon: Table2, desc: "Tabela de demonstrativo com Totais, Contas Redutoras e Contas Analiticas", whenToUse: "Quando montar um demonstrativo financeiro com totais, contas redutoras e contas analiticas." },
  { value: "line", label: "Linha", icon: LineChart, desc: "Serie temporal agregada", whenToUse: "Quando analisar tendencia ao longo do tempo." },
  { value: "table", label: "Tabela", icon: Table2, desc: "Linhas detalhadas com colunas selecionadas", whenToUse: "Quando precisar ver detalhes linha a linha e exportar dados." },
  { value: "text", label: "Texto", icon: TextCursorInput, desc: "Bloco de texto livre para título ou anotações", whenToUse: "Quando incluir contexto, explicações ou instrucoes no dashboard." },
];

interface AddWidgetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (widgetType: WidgetType) => void;
  viewLabel?: string;
}

export const AddWidgetDialog = ({ open, onOpenChange, onAdd, viewLabel }: AddWidgetDialogProps) => {
  const [selectedType, setSelectedType] = useState<WidgetType | null>(null);

  const handleAdd = () => {
    if (!selectedType) return;
    onAdd(selectedType);
    setSelectedType(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Adicionar Widget</DialogTitle>
          <DialogDescription>
            Escolha o tipo para <strong>{viewLabel || "-"}</strong>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 pt-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {widgetTypes.map((wt) => (
              <Tooltip key={wt.value}>
                <TooltipTrigger asChild>
                  <motion.button
                    whileHover={{ scale: 1.04 }}
                    whileTap={{ scale: 0.96 }}
                    onClick={() => setSelectedType(wt.value)}
                    className={`flex flex-col items-center gap-1.5 rounded-xl p-3 text-xs font-medium transition-all border ${
                      selectedType === wt.value
                        ? "bg-accent text-accent-foreground border-accent shadow-sm"
                        : "bg-card text-muted-foreground border-border hover:bg-secondary hover:text-foreground"
                    }`}
                  >
                    <wt.icon className="h-5 w-5" />
                    {wt.label}
                  </motion.button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[280px] text-xs">
                  {wt.whenToUse}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
          {selectedType && (
            <p className="text-xs text-muted-foreground">
              {widgetTypes.find((w) => w.value === selectedType)?.desc}
            </p>
          )}

          <Button
            className="w-full bg-accent text-accent-foreground hover:bg-accent/90"
            disabled={!selectedType}
            onClick={handleAdd}
          >
            Adicionar ao Dashboard
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
