import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus, Settings2, GripVertical, MoreHorizontal, Trash2, Columns2, Columns3,
  LayoutGrid, Pencil, ChevronUp, ChevronDown, Eye, EyeOff, Copy, Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DashboardSection, DashboardWidget } from "@/types/dashboard";
import { WidgetRenderer } from "./WidgetRenderer";

interface DashboardCanvasProps {
  dashboardId?: string;
  sections: DashboardSection[];
  onSectionsChange: (sections: DashboardSection[]) => void;
  onAddWidget: (sectionId: string) => void;
  onEditWidget: (widget: DashboardWidget) => void;
  onDeleteWidget: (widget: DashboardWidget) => void;
  onDuplicateWidget: (widget: DashboardWidget) => void;
  onToggleWidgetTitle: (widget: DashboardWidget) => void;
  onAddSection: () => void;
  readOnly?: boolean;
}

const columnOptions = [
  { value: 1 as const, label: "1 Coluna", icon: Square },
  { value: 2 as const, label: "2 Colunas", icon: Columns2 },
  { value: 3 as const, label: "3 Colunas", icon: Columns3 },
  { value: 4 as const, label: "4 Colunas", icon: LayoutGrid },
];

const getWidgetWidthClass = (sectionColumns: 1 | 2 | 3 | 4, width: 1 | 2 | 3 | 4) => {
  const clampedWidth = Math.min(width, sectionColumns) as 1 | 2 | 3 | 4;
  if (sectionColumns === 1) return "col-span-1";
  if (sectionColumns === 2) return clampedWidth >= 2 ? "md:col-span-2" : "md:col-span-1";
  if (sectionColumns === 3) {
    if (clampedWidth >= 3) return "md:col-span-2 lg:col-span-3";
    if (clampedWidth === 2) return "md:col-span-2 lg:col-span-2";
    return "md:col-span-1 lg:col-span-1";
  }
  if (clampedWidth >= 4) return "md:col-span-2 lg:col-span-4";
  if (clampedWidth === 3) return "md:col-span-2 lg:col-span-3";
  if (clampedWidth === 2) return "md:col-span-2 lg:col-span-2";
  return "md:col-span-1 lg:col-span-1";
};

const WidgetCard = ({
  dashboardId,
  sectionColumns,
  widget,
  onEdit,
  onDelete,
  onDuplicate,
  onToggleTitle,
  readOnly = false,
}: {
  dashboardId?: string;
  sectionColumns: 1 | 2 | 3 | 4;
  widget: DashboardWidget;
  onEdit: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onToggleTitle: () => void;
  readOnly?: boolean;
}) => (
  <motion.div
    layout
    initial={{ opacity: 0, scale: 0.95 }}
    animate={{ opacity: 1, scale: 1 }}
    exit={{ opacity: 0, scale: 0.95 }}
    className={`glass-card group relative self-start flex flex-col overflow-hidden transition-all ${
      readOnly ? "" : "cursor-pointer hover:ring-2 hover:ring-accent/30"
    } ${getWidgetWidthClass(sectionColumns, widget.config.size?.width || 1)}`}
    onClick={() => !readOnly && onEdit()}
  >
    {widget.config.show_title !== false && (
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/50">
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-foreground truncate">
            {widget.title || "Sem titulo"}
          </h4>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                  onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Duplicar widget</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                  onClick={(e) => { e.stopPropagation(); onToggleTitle(); }}
                >
                  <Eye className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Ocultar titulo</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                  onClick={(e) => { e.stopPropagation(); onEdit(); }}
                >
                  <Settings2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Configurar</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 text-destructive hover:text-destructive"
                  onClick={(e) => { e.stopPropagation(); onDelete(); }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Excluir widget</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
    )}
    {!readOnly && widget.config.show_title === false && (
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={(e) => { e.stopPropagation(); onToggleTitle(); }}
        >
          <EyeOff className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
        >
          <Settings2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    )}
    <div className={`p-3 flex items-center justify-center ${widget.config.size?.height === 0.5 ? "min-h-[100px]" : "min-h-[180px]"}`}>
      <WidgetRenderer widget={widget} dashboardId={dashboardId} heightMultiplier={widget.config.size?.height || 1} />
    </div>
  </motion.div>
);

const SectionBlock = ({
  dashboardId,
  section,
  index,
  total,
  onChange,
  onDelete,
  onMove,
  onAddWidget,
  onEditWidget,
  onDeleteWidget,
  onDuplicateWidget,
  onToggleWidgetTitle,
  readOnly = false,
}: {
  dashboardId?: string;
  section: DashboardSection;
  index: number;
  total: number;
  onChange: (s: DashboardSection) => void;
  onDelete: () => void;
  onMove: (dir: "up" | "down") => void;
  onAddWidget: () => void;
  onEditWidget: (w: DashboardWidget) => void;
  onDeleteWidget: (w: DashboardWidget) => void;
  onDuplicateWidget: (w: DashboardWidget) => void;
  onToggleWidgetTitle: (w: DashboardWidget) => void;
  readOnly?: boolean;
}) => {
  const [editingTitle, setEditingTitle] = useState(false);

  const gridCols = {
    1: "grid-cols-1",
    2: "grid-cols-1 md:grid-cols-2",
    3: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3",
    4: "grid-cols-1 md:grid-cols-2 lg:grid-cols-4",
  }[section.columns];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="group/section"
    >
      <div className="flex items-center gap-2 mb-3">
        <GripVertical className="h-4 w-4 text-muted-foreground/40 shrink-0" />
        {!readOnly && editingTitle ? (
          <Input
            autoFocus
            value={section.title}
            onChange={(e) => onChange({ ...section, title: e.target.value })}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(e) => e.key === "Enter" && setEditingTitle(false)}
            className="h-7 text-sm font-semibold max-w-[240px]"
            placeholder="Nome da secao"
          />
        ) : (
          <button
            onClick={() => !readOnly && setEditingTitle(true)}
            className={`text-sm font-semibold text-foreground transition-colors flex items-center gap-1 ${readOnly ? "" : "hover:text-accent"}`}
          >
            {section.title || "Secao sem titulo"}
            {!readOnly && <Pencil className="h-3 w-3 opacity-0 group-hover/section:opacity-100 transition-opacity" />}
          </button>
        )}
        {!readOnly && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => onChange({ ...section, showTitle: section.showTitle === false })}
                className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                {section.showTitle === false ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent className="text-xs">{section.showTitle === false ? "Mostrar titulo da secao" : "Ocultar titulo da secao"}</TooltipContent>
          </Tooltip>
        )}

        <div className="flex-1" />

        {!readOnly && <div className="flex items-center gap-0.5 opacity-0 group-hover/section:opacity-100 transition-opacity">
          {columnOptions.map((opt) => (
            <Tooltip key={opt.value}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onChange({ ...section, columns: opt.value })}
                  className={`rounded-md p-1.5 transition-colors ${
                    section.columns === opt.value
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-secondary"
                  }`}
                >
                  <opt.icon className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">{opt.label}</TooltipContent>
            </Tooltip>
          ))}
        </div>}

        {!readOnly && <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover/section:opacity-100 transition-opacity">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {index > 0 && (
              <DropdownMenuItem onClick={() => onMove("up")}>
                <ChevronUp className="h-3.5 w-3.5 mr-2" /> Mover para cima
              </DropdownMenuItem>
            )}
            {index < total - 1 && (
              <DropdownMenuItem onClick={() => onMove("down")}>
                <ChevronDown className="h-3.5 w-3.5 mr-2" /> Mover para baixo
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
              <Trash2 className="h-3.5 w-3.5 mr-2" /> Excluir secao
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>}
      </div>

      <div className={`grid ${gridCols} gap-4`}>
        <AnimatePresence mode="popLayout">
          {section.widgets.map((w) => (
            <WidgetCard
              key={w.id}
              dashboardId={dashboardId}
              sectionColumns={section.columns}
              widget={w}
              onEdit={() => onEditWidget(w)}
              onDelete={() => onDeleteWidget(w)}
              onDuplicate={() => onDuplicateWidget(w)}
              onToggleTitle={() => onToggleWidgetTitle(w)}
              readOnly={readOnly}
            />
          ))}
        </AnimatePresence>

        {!readOnly && (
          <motion.button
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            onClick={onAddWidget}
            className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border/60 text-muted-foreground hover:border-accent/40 hover:text-accent transition-all min-h-[180px] p-6"
          >
            <Plus className="h-6 w-6" />
            <span className="text-xs font-medium">Adicionar Widget</span>
          </motion.button>
        )}
      </div>
    </motion.div>
  );
};

export const DashboardCanvas = ({
  dashboardId,
  sections,
  onSectionsChange,
  onAddWidget,
  onEditWidget,
  onDeleteWidget,
  onDuplicateWidget,
  onToggleWidgetTitle,
  onAddSection,
  readOnly = false,
}: DashboardCanvasProps) => {
  const updateSection = (id: string, updated: DashboardSection) => {
    onSectionsChange(sections.map((s) => (s.id === id ? updated : s)));
  };

  const deleteSection = (id: string) => {
    onSectionsChange(sections.filter((s) => s.id !== id));
  };

  const moveSection = (index: number, dir: "up" | "down") => {
    const arr = [...sections];
    const target = dir === "up" ? index - 1 : index + 1;
    [arr[index], arr[target]] = [arr[target], arr[index]];
    onSectionsChange(arr);
  };

  return (
    <div className="space-y-8">
      <AnimatePresence mode="popLayout">
        {sections.map((section, i) => (
          <SectionBlock
            key={section.id}
            dashboardId={dashboardId}
            section={section}
            index={i}
            total={sections.length}
            onChange={(s) => updateSection(section.id, s)}
            onDelete={() => deleteSection(section.id)}
            onMove={(dir) => moveSection(i, dir)}
            onAddWidget={() => onAddWidget(section.id)}
            onEditWidget={onEditWidget}
            onDeleteWidget={onDeleteWidget}
            onDuplicateWidget={onDuplicateWidget}
            onToggleWidgetTitle={onToggleWidgetTitle}
            readOnly={readOnly}
          />
        ))}
      </AnimatePresence>

      {!readOnly && (
        <motion.button
          whileHover={{ scale: 1.005 }}
          whileTap={{ scale: 0.995 }}
          onClick={onAddSection}
          className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border/50 text-muted-foreground hover:border-accent/40 hover:text-accent transition-all py-6"
        >
          <Plus className="h-5 w-5" />
          <span className="text-sm font-medium">Adicionar Secao</span>
        </motion.button>
      )}
    </div>
  );
};
