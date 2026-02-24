import { forwardRef, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
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
  onAddSection: (afterIndex?: number) => void;
  readOnly?: boolean;
}

const columnOptions = [
  { value: 1 as const, label: "1 Coluna", icon: Square },
  { value: 2 as const, label: "2 Colunas", icon: Columns2 },
  { value: 3 as const, label: "3 Colunas", icon: Columns3 },
  { value: 4 as const, label: "4 Colunas", icon: LayoutGrid },
];

const getWidgetWidth = (widget: DashboardWidget, sectionColumns: 1 | 2 | 3 | 4): 1 | 2 | 3 | 4 => {
  const raw = widget.config.size?.width || 1;
  return Math.min(sectionColumns, Math.max(1, raw)) as 1 | 2 | 3 | 4;
};

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

const getLastRowRemaining = (widgets: DashboardWidget[], sectionColumns: 1 | 2 | 3 | 4): number => {
  if (widgets.length === 0) return sectionColumns;
  let used = 0;
  for (let i = 0; i < widgets.length; i += 1) {
    const w = getWidgetWidth(widgets[i], sectionColumns);
    if (used + w > sectionColumns) used = 0;
    used += w;
    if (used === sectionColumns) used = 0;
  }
  return used === 0 ? 0 : sectionColumns - used;
};

const getMaxWidthAtIndex = (widgets: DashboardWidget[], index: number, sectionColumns: 1 | 2 | 3 | 4): 1 | 2 | 3 | 4 => {
  let used = 0;
  for (let i = 0; i <= index; i += 1) {
    const width = getWidgetWidth(widgets[i], sectionColumns);
    if (used + width > sectionColumns) used = 0;
    if (i === index) {
      return Math.max(1, sectionColumns - used) as 1 | 2 | 3 | 4;
    }
    used += width;
    if (used === sectionColumns) used = 0;
  }
  return sectionColumns;
};

type WidgetCardProps = {
  dashboardId?: string;
  sectionColumns: 1 | 2 | 3 | 4;
  widget: DashboardWidget;
  canDrag?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDragOver?: () => void;
  onDrop?: () => void;
  onResizeStart?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onEdit: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onToggleTitle: () => void;
  readOnly?: boolean;
};

const WidgetCard = forwardRef<HTMLDivElement, WidgetCardProps>(({
  dashboardId,
  sectionColumns,
  widget,
  canDrag = false,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onResizeStart,
  onEdit,
  onDelete,
  onDuplicate,
  onToggleTitle,
  readOnly = false,
}, ref) => (
  <motion.div
    ref={ref}
    layout
    draggable={canDrag}
    onDragStart={() => onDragStart?.()}
    onDragEnd={() => onDragEnd?.()}
    onDragOver={(event) => {
      if (!canDrag) return;
      event.preventDefault();
      onDragOver?.();
    }}
    onDrop={(event) => {
      if (!canDrag) return;
      event.preventDefault();
      onDrop?.();
    }}
    initial={{ opacity: 0, scale: 0.95 }}
    animate={{ opacity: 1, scale: 1 }}
    exit={{ opacity: 0, scale: 0.95 }}
    className={`glass-card group relative self-start flex flex-col overflow-hidden transition-all ${
      readOnly ? "" : "cursor-pointer hover:ring-2 hover:ring-accent/30"
    } ${getWidgetWidthClass(sectionColumns, widget.config.size?.width || 1)}`}
    onClick={() => !readOnly && onEdit()}
  >
    {!readOnly && (
      <div
        className="absolute top-0 right-0 z-20 h-full w-2 cursor-e-resize bg-transparent hover:bg-accent/20"
        onMouseDown={(event) => {
          event.stopPropagation();
          onResizeStart?.(event);
        }}
      />
    )}
    {widget.config.show_title !== false && (
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/50">
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-foreground truncate">
            {widget.title || "Sem título"}
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
              <TooltipContent className="text-xs">Ocultar título</TooltipContent>
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
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={(e) => { e.stopPropagation(); onDuplicate(); }}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={(e) => { e.stopPropagation(); onToggleTitle(); }}>
          <EyeOff className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={(e) => { e.stopPropagation(); onEdit(); }}>
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
));
WidgetCard.displayName = "WidgetCard";

const SectionBlock = ({
  dashboardId,
  section,
  index,
  total,
  draggedSectionId,
  onStartSectionDrag,
  onDropSection,
  onChange,
  onDelete,
  onMove,
  onAddWidget,
  onReorderWidget,
  onResizeWidget,
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
  draggedSectionId: string | null;
  onStartSectionDrag: (sectionId: string | null) => void;
  onDropSection: (targetSectionId: string) => void;
  onChange: (s: DashboardSection) => void;
  onDelete: () => void;
  onMove: (dir: "up" | "down") => void;
  onAddWidget: () => void;
  onReorderWidget: (draggedId: string, targetId: string) => void;
  onResizeWidget: (widgetId: string, width: 1 | 2 | 3 | 4) => void;
  onEditWidget: (w: DashboardWidget) => void;
  onDeleteWidget: (w: DashboardWidget) => void;
  onDuplicateWidget: (w: DashboardWidget) => void;
  onToggleWidgetTitle: (w: DashboardWidget) => void;
  readOnly?: boolean;
}) => {
  const [editingTitle, setEditingTitle] = useState(false);
  const [draggedWidgetId, setDraggedWidgetId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [gridWidth, setGridWidth] = useState(0);
  const canAddWidget = getLastRowRemaining(section.widgets, section.columns) > 0;

  useEffect(() => {
    if (!gridRef.current) return;
    const node = gridRef.current;
    const update = () => setGridWidth(node.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const cellWidth = useMemo(() => {
    if (!gridWidth) return 240;
    const gapPx = 16;
    return (gridWidth - ((section.columns - 1) * gapPx)) / section.columns;
  }, [gridWidth, section.columns]);

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
      onDragOver={(event) => {
        if (!readOnly && draggedSectionId && draggedSectionId !== section.id) event.preventDefault();
      }}
      onDrop={(event) => {
        if (readOnly) return;
        event.preventDefault();
        onDropSection(section.id);
      }}
      className="group/section"
    >
      <div className="flex items-center gap-2 mb-3">
        <button
          type="button"
          draggable={!readOnly}
          onDragStart={() => !readOnly && onStartSectionDrag(section.id)}
          onDragEnd={() => !readOnly && onStartSectionDrag(null)}
          className="cursor-grab active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4 text-muted-foreground/40 shrink-0" />
        </button>
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
            {section.title || "Secao sem título"}
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
            <TooltipContent className="text-xs">{section.showTitle === false ? "Mostrar título da secao" : "Ocultar título da secao"}</TooltipContent>
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
                    section.columns === opt.value ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-secondary"
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
            {index > 0 && <DropdownMenuItem onClick={() => onMove("up")}><ChevronUp className="h-3.5 w-3.5 mr-2" /> Mover para cima</DropdownMenuItem>}
            {index < total - 1 && <DropdownMenuItem onClick={() => onMove("down")}><ChevronDown className="h-3.5 w-3.5 mr-2" /> Mover para baixo</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
              <Trash2 className="h-3.5 w-3.5 mr-2" /> Excluir secao
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>}
      </div>

      <div ref={gridRef} className={`grid ${gridCols} gap-4`}>
        <AnimatePresence mode="popLayout">
          {section.widgets.map((w, widgetIndex) => (
            <WidgetCard
              key={w.id}
              dashboardId={dashboardId}
              sectionColumns={section.columns}
              widget={w}
              canDrag={!readOnly}
              onDragStart={() => setDraggedWidgetId(w.id)}
              onDragEnd={() => setDraggedWidgetId(null)}
              onDragOver={() => undefined}
              onDrop={() => {
                if (!draggedWidgetId || draggedWidgetId === w.id) return;
                onReorderWidget(draggedWidgetId, w.id);
                setDraggedWidgetId(null);
              }}
              onResizeStart={(event) => {
                if (readOnly) return;
                const startX = event.clientX;
                const startWidth = getWidgetWidth(w, section.columns);
                const maxWidth = getMaxWidthAtIndex(section.widgets, widgetIndex, section.columns);
                const onMove = (moveEvent: MouseEvent) => {
                  const deltaCols = Math.round((moveEvent.clientX - startX) / Math.max(1, cellWidth));
                  const nextWidth = Math.max(1, Math.min(maxWidth, (startWidth + deltaCols))) as 1 | 2 | 3 | 4;
                  onResizeWidget(w.id, nextWidth);
                };
                const onUp = () => {
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }}
              onEdit={() => onEditWidget(w)}
              onDelete={() => onDeleteWidget(w)}
              onDuplicate={() => onDuplicateWidget(w)}
              onToggleTitle={() => onToggleWidgetTitle(w)}
              readOnly={readOnly}
            />
          ))}
        </AnimatePresence>

        {!readOnly && canAddWidget && (
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
  const [draggedSectionId, setDraggedSectionId] = useState<string | null>(null);

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

  const dropSectionOnTarget = (targetSectionId: string) => {
    if (!draggedSectionId || draggedSectionId === targetSectionId) return;
    const arr = [...sections];
    const fromIndex = arr.findIndex((s) => s.id === draggedSectionId);
    const toIndex = arr.findIndex((s) => s.id === targetSectionId);
    if (fromIndex < 0 || toIndex < 0) return;
    const [moved] = arr.splice(fromIndex, 1);
    arr.splice(toIndex, 0, moved);
    onSectionsChange(arr);
    setDraggedSectionId(null);
  };

  const reorderWidgetInSection = (sectionId: string, draggedWidgetId: string, targetWidgetId: string) => {
    onSectionsChange(sections.map((section) => {
      if (section.id !== sectionId) return section;
      const widgets = [...section.widgets];
      const fromIndex = widgets.findIndex((item) => item.id === draggedWidgetId);
      const toIndex = widgets.findIndex((item) => item.id === targetWidgetId);
      if (fromIndex < 0 || toIndex < 0) return section;
      const [moved] = widgets.splice(fromIndex, 1);
      widgets.splice(toIndex, 0, moved);
      return { ...section, widgets };
    }));
  };

  const resizeWidgetInSection = (sectionId: string, widgetId: string, width: 1 | 2 | 3 | 4) => {
    onSectionsChange(sections.map((section) => {
      if (section.id !== sectionId) return section;
      return {
        ...section,
        widgets: section.widgets.map((widget) => (
          widget.id === widgetId
            ? { ...widget, config: { ...widget.config, size: { width, height: widget.config.size?.height || 1 } } }
            : widget
        )),
      };
    }));
  };

  return (
    <div className="space-y-8">
      <AnimatePresence mode="popLayout">
        {sections.map((section, i) => (
          <div key={section.id} className="space-y-4">
            <SectionBlock
              dashboardId={dashboardId}
              section={section}
              index={i}
              total={sections.length}
              draggedSectionId={draggedSectionId}
              onStartSectionDrag={setDraggedSectionId}
              onDropSection={dropSectionOnTarget}
              onChange={(s) => updateSection(section.id, s)}
              onDelete={() => deleteSection(section.id)}
              onMove={(dir) => moveSection(i, dir)}
              onAddWidget={() => onAddWidget(section.id)}
              onReorderWidget={(draggedId, targetId) => reorderWidgetInSection(section.id, draggedId, targetId)}
              onResizeWidget={(widgetId, width) => resizeWidgetInSection(section.id, widgetId, width)}
              onEditWidget={onEditWidget}
              onDeleteWidget={onDeleteWidget}
              onDuplicateWidget={onDuplicateWidget}
              onToggleWidgetTitle={onToggleWidgetTitle}
              readOnly={readOnly}
            />
            {!readOnly && (
              <motion.button
                whileHover={{ scale: 1.002 }}
                whileTap={{ scale: 0.998 }}
                onClick={() => onAddSection(i + 1)}
                className="w-full flex items-center justify-center gap-2 rounded-xl border border-dashed border-border/50 text-muted-foreground hover:border-accent/40 hover:text-accent transition-all py-3"
              >
                <Plus className="h-4 w-4" />
                <span className="text-xs font-medium">Adicionar Secao</span>
              </motion.button>
            )}
          </div>
        ))}
      </AnimatePresence>
    </div>
  );
};
