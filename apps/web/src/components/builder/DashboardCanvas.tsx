import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import GridLayout, { horizontalCompactor, useContainerWidth, type Layout, type LayoutItem } from "react-grid-layout";
import { AnimatePresence, motion } from "framer-motion";
import {
  Plus,
  Settings2,
  MoreHorizontal,
  Trash2,
  Pencil,
  ChevronUp,
  ChevronDown,
  Hash,
  BarChart3,
  LineChart,
  PieChart,
  Table2,
  Columns3,
  Copy,
  Eye,
  EyeOff,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { VisualizationType } from "@/types";
import {
  SECTION_GRID_COLS,
  gridRowsToWidgetHeight,
  widgetHeightToGridRows,
  normalizeLayoutItem,
  snapToCanonicalWidgetWidth,
  type DashboardLayoutItem,
  type DashboardSection,
  type DashboardWidget,
  type WidgetType,
} from "@/types/dashboard";
import { getWidgetCatalogByType, getWidgetCatalogByVisualization, WIDGET_CATALOG } from "@/components/builder/widget-catalog";
import { WidgetRenderer } from "./WidgetRenderer";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

const DND_MIME = "application/x-istari-builder-dnd";
const GRID_GUIDES = Array.from({ length: SECTION_GRID_COLS });
const NEW_WIDGET_DRAG_STATE_EVENT = "builder:new-widget-drag-state";
const GRID_ROW_HEIGHT = 36;
const GRID_MARGIN_X = 16;
const GRID_MARGIN_Y = 16;

interface DashboardCanvasProps {
  dashboardId?: string;
  datasetId?: number;
  nativeFilters?: Array<{ column: string; op: string; value?: unknown }>;
  sections: DashboardSection[];
  onSectionsChange: (sections: DashboardSection[]) => void;
  onAddWidget: (
    sectionId: string,
    type: VisualizationType,
    placement?: Pick<DashboardLayoutItem, "x" | "y" | "w" | "h">,
    preferredWidgetType?: WidgetType,
  ) => void;
  onEditWidget: (widget: DashboardWidget) => void;
  onDeleteWidget: (widget: DashboardWidget) => void;
  onDuplicateWidget: (widget: DashboardWidget) => void;
  onToggleWidgetTitle: (widget: DashboardWidget) => void;
  onAddSection: (afterIndex?: number) => void;
  onCommitSectionLayout?: (sectionId: string, layout: DashboardLayoutItem[]) => void;
  readOnly?: boolean;
  builderMode?: boolean;
  refreshingWidgetIds?: Set<string>;
}

type NewWidgetDragPayload = { kind: "new-widget"; widgetType: VisualizationType; preferredWidgetType?: WidgetType };

const widgetTypeIconByWidget: Record<WidgetType, typeof Hash> = {
  kpi: Hash,
  bar: BarChart3,
  line: LineChart,
  donut: PieChart,
  table: Table2,
  column: BarChart3,
  text: Table2,
  dre: Columns3,
};

const parseNewWidgetDragPayload = (dataTransfer?: DataTransfer | null): NewWidgetDragPayload | null => {
  const raw = dataTransfer?.getData(DND_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { kind?: string; widgetType?: VisualizationType; preferredWidgetType?: WidgetType };
    if (parsed.kind !== "new-widget" || !parsed.widgetType) return null;
    return {
      kind: "new-widget",
      widgetType: parsed.widgetType,
      preferredWidgetType: parsed.preferredWidgetType,
    };
  } catch {
    return null;
  }
};

type GridPointerEventLike = Event | {
  clientX?: number;
  clientY?: number;
  changedTouches?: TouchList | null;
};

const getClientPointFromGridEvent = (event: GridPointerEventLike): { x: number; y: number } | null => {
  const pointerEvent = event as { clientX?: number; clientY?: number };
  if (typeof pointerEvent.clientX === "number" && typeof pointerEvent.clientY === "number") {
    return { x: pointerEvent.clientX, y: pointerEvent.clientY };
  }
  const touchLike = event as { changedTouches?: TouchList | null };
  const changedTouches = touchLike.changedTouches;
  if (changedTouches && changedTouches.length > 0) {
    return { x: changedTouches[0].clientX, y: changedTouches[0].clientY };
  }
  return null;
};

const getWidgetPaddingClass = (padding?: "compact" | "normal" | "comfortable"): string => {
  if (padding === "compact") return "p-2";
  if (padding === "comfortable") return "p-4";
  return "p-3";
};

const getWidgetMinHeightClass = (height?: 0.5 | 1 | 2): string => {
  if (height === 0.5) return "min-h-[100px]";
  if (height === 2) return "min-h-[320px]";
  return "min-h-[180px]";
};

const getGridColumnWidth = (gridWidth: number): number => (
  Math.max(0, (gridWidth - (GRID_MARGIN_X * (SECTION_GRID_COLS - 1))) / SECTION_GRID_COLS)
);

const getDropXFromClientPoint = (
  clientX: number,
  gridRect: DOMRect,
  gridWidth: number,
  widgetWidth: number,
): number => {
  const columnWidth = getGridColumnWidth(gridWidth);
  const step = columnWidth + GRID_MARGIN_X;
  const relativeX = clientX - gridRect.left;
  const rawX = Math.floor((relativeX + (GRID_MARGIN_X / 2)) / Math.max(1, step));
  return Math.max(0, Math.min(SECTION_GRID_COLS - widgetWidth, rawX));
};

const toDropPreviewStyle = (placement: Pick<DashboardLayoutItem, "x" | "y" | "w" | "h">, gridWidth: number) => {
  const columnWidth = getGridColumnWidth(gridWidth);
  return {
    left: placement.x * (columnWidth + GRID_MARGIN_X),
    top: placement.y * (GRID_ROW_HEIGHT + GRID_MARGIN_Y),
    width: (placement.w * columnWidth) + ((placement.w - 1) * GRID_MARGIN_X),
    height: (placement.h * GRID_ROW_HEIGHT) + ((placement.h - 1) * GRID_MARGIN_Y),
  };
};

const toLayoutById = (section: DashboardSection): Record<string, DashboardLayoutItem> => {
  const fromState = new Map((section.layout || []).map((item) => [item.i, normalizeLayoutItem(item)]));
  const byId: Record<string, DashboardLayoutItem> = {};
  section.widgets.forEach((widget, index) => {
    const catalog = getWidgetCatalogByType(widget.props.widget_type);
    const existing = fromState.get(widget.id);
    if (existing) {
      byId[widget.id] = normalizeLayoutItem({
        ...existing,
        i: widget.id,
        w: Math.max(catalog.minW, Math.min(catalog.maxW, existing.w)),
        h: Math.max(catalog.minH, existing.h),
      });
      return;
    }
    const widthFromProps = widget.props.size?.width;
    const heightFromProps = widget.props.size?.height ? widgetHeightToGridRows(widget.props.size.height) : undefined;
    byId[widget.id] = {
      i: widget.id,
      x: 0,
      y: index * catalog.defaultH,
      w: Math.max(catalog.minW, Math.min(catalog.maxW, snapToCanonicalWidgetWidth(widthFromProps ?? catalog.defaultW))),
      h: Math.max(catalog.minH, heightFromProps ?? catalog.minH),
    };
  });
  return byId;
};

const normalizeRglLayout = (layout: Layout, section: DashboardSection): DashboardLayoutItem[] => {
  const widgetById = new Map(section.widgets.map((widget) => [widget.id, widget]));
  return layout
    .filter((item) => widgetById.has(item.i))
    .map((item: LayoutItem) => {
      const widget = widgetById.get(item.i)!;
      const catalog = getWidgetCatalogByType(widget.props.widget_type);
      const snappedWidth = snapToCanonicalWidgetWidth(item.w);
      const clampedWidth = Math.max(catalog.minW, Math.min(catalog.maxW, snappedWidth));
      const clampedHeight = Math.max(catalog.minH, Math.floor(item.h));
      return normalizeLayoutItem({
        i: item.i,
        x: Math.max(0, Math.min(SECTION_GRID_COLS - 1, Math.floor(item.x))),
        y: 0,
        w: clampedWidth,
        h: clampedHeight,
      });
    });
};

const resolveSequentialLayout = (
  layout: DashboardLayoutItem[],
  section: DashboardSection,
  activeItemId?: string,
): DashboardLayoutItem[] => {
  const previousById = new Map(
    (section.layout || [])
      .map((item) => normalizeLayoutItem(item))
      .filter((item) => section.widgets.some((widget) => widget.id === item.i))
      .map((item) => [item.i, item]),
  );
  const widgetOrder = new Map(section.widgets.map((widget, index) => [widget.id, index]));
  const incomingById = new Map(layout.map((item) => [item.i, normalizeLayoutItem(item)]));

  const sortedIds = Array.from(new Set([
    ...section.widgets.map((widget) => widget.id),
    ...layout.map((item) => item.i),
  ])).sort((idA, idB) => {
    const itemA = incomingById.get(idA) || previousById.get(idA);
    const itemB = incomingById.get(idB) || previousById.get(idB);
    const xA = itemA?.x ?? 0;
    const xB = itemB?.x ?? 0;
    if (xA !== xB) return xA - xB;
    return (widgetOrder.get(idA) ?? Number.MAX_SAFE_INTEGER) - (widgetOrder.get(idB) ?? Number.MAX_SAFE_INTEGER);
  });

  const activeItem = activeItemId ? (incomingById.get(activeItemId) || previousById.get(activeItemId)) : null;
  const orderedIds = (() => {
    if (!activeItem || !activeItemId) return sortedIds;
    const others = sortedIds.filter((id) => id !== activeItemId);
    const activePreferredX = Math.max(0, Math.min(SECTION_GRID_COLS - activeItem.w, activeItem.x));
    const insertIndex = others.findIndex((id) => {
      const item = incomingById.get(id) || previousById.get(id);
      if (!item) return false;
      return activePreferredX < (item.x + item.w);
    });
    if (insertIndex >= 0) {
      return [...others.slice(0, insertIndex), activeItemId, ...others.slice(insertIndex)];
    }
    return [...others, activeItemId];
  })();

  let cursorX = 0;
  const placed: DashboardLayoutItem[] = [];
  for (const id of orderedIds) {
    const item = incomingById.get(id) || previousById.get(id);
    if (!item) continue;
    const width = Math.max(1, Math.min(SECTION_GRID_COLS, item.w));
    const height = Math.max(1, item.h);
    if (cursorX + width > SECTION_GRID_COLS) {
      const fallback = (section.layout || [])
        .map((existing) => normalizeLayoutItem(existing))
        .filter((existing) => section.widgets.some((widget) => widget.id === existing.i))
        .map((existing) => ({ ...existing, y: 0 }))
        .sort((a, b) => a.x - b.x);
      return fallback;
    }
    placed.push(normalizeLayoutItem({
      ...item,
      w: width,
      h: height,
      x: cursorX,
      y: 0,
    }));
    cursorX += width;
  }

  return placed.sort((a, b) => a.x - b.x);
};

const WidgetCard = ({
  dashboardId,
  datasetId,
  nativeFilters,
  widget,
  layoutItem,
  readOnly = false,
  builderMode = false,
  isRefreshing = false,
  shouldSuppressEditClick,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  dashboardId?: string;
  datasetId?: number;
  nativeFilters?: Array<{ column: string; op: string; value?: unknown }>;
  widget: DashboardWidget;
  layoutItem: DashboardLayoutItem;
  readOnly?: boolean;
  builderMode?: boolean;
  isRefreshing?: boolean;
  shouldSuppressEditClick?: () => boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) => {
  const heightHint = gridRowsToWidgetHeight(layoutItem.h);
  const isNarrowWidget = layoutItem.w <= 2;
  const actionGroupClass = "widget-content-interactive widget-actions flex items-center gap-1 pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100";
  const displayWidget: DashboardWidget = {
    ...widget,
    props: {
      ...widget.props,
      size: {
        width: layoutItem.w as 1 | 2 | 3 | 4 | 5 | 6,
        height: heightHint,
      },
    },
  };
  displayWidget.config = displayWidget.props;
  const forceMinHeight = readOnly;
  const handleCardClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (readOnly) return;
    if (shouldSuppressEditClick?.()) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest(".widget-resize-handle,button,input,textarea,select,a,[role='button']")) {
      return;
    }
    onEdit();
  };

  return (
    <div className={cn(
      "glass-card widget-drag-surface group relative flex h-full min-h-0 flex-col overflow-hidden transition-all",
      readOnly ? "" : "cursor-pointer hover:ring-2 hover:ring-accent/30 hover:shadow-card-hover",
    )}
      onClick={handleCardClick}
    >
      {!readOnly && displayWidget.props.show_title === false && (
        <>
          <div className={cn(actionGroupClass, "absolute right-2 top-2 z-20 rounded-md border border-border/70 bg-card/90 p-0.5")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                onDuplicate();
              }}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                onEdit();
              }}
            >
              <Settings2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </>
      )}

      {displayWidget.props.show_title !== false && (
        <div className={cn("border-b border-border/50", isNarrowWidget ? "px-3 py-2" : "px-4 py-2.5")}>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className={cn("truncate font-semibold", isNarrowWidget ? "text-xs" : "text-sm")}>
                {displayWidget.title || "Sem titulo"}
              </p>
              {!isNarrowWidget && displayWidget.props.widget_type !== "line" && (
                <p className="truncate text-[11px] text-muted-foreground">{displayWidget.props.view_name}</p>
              )}
            </div>
            {!readOnly && (
              <div className={actionGroupClass}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDuplicate();
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={(event) => {
                    event.stopPropagation();
                    onEdit();
                  }}
                >
                  <Settings2 className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete();
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      <div
        className={cn(
          "widget-content-interactive min-h-0 flex-1",
          getWidgetPaddingClass(displayWidget.props.visual_padding),
          forceMinHeight && getWidgetMinHeightClass(heightHint),
        )}
      >
        <div className="h-full w-full">
          <WidgetRenderer
            widget={displayWidget}
            dashboardId={dashboardId}
            datasetId={datasetId}
            nativeFilters={nativeFilters}
            builderMode={builderMode}
            heightMultiplier={heightHint}
            layoutRows={layoutItem.h}
            hideTableExport={!readOnly}
            forcedLoading={isRefreshing}
          />
        </div>
      </div>
    </div>
  );
};

const SectionBlock = ({
  dashboardId,
  datasetId,
  nativeFilters,
  section,
  index,
  total,
  onChange,
  onDelete,
  onMove,
  onAddWidget,
  onLayoutChange,
  onLayoutCommit,
  onEditWidget,
  onDeleteWidget,
  onDuplicateWidget,
  readOnly = false,
  builderMode = false,
  refreshingWidgetIds = new Set(),
}: {
  dashboardId?: string;
  datasetId?: number;
  nativeFilters?: Array<{ column: string; op: string; value?: unknown }>;
  section: DashboardSection;
  index: number;
  total: number;
  onChange: (section: DashboardSection) => void;
  onDelete: () => void;
  onMove: (dir: "up" | "down") => void;
  onAddWidget: (
    type: VisualizationType,
    placement?: Pick<DashboardLayoutItem, "x" | "y" | "w" | "h">,
    preferredWidgetType?: WidgetType,
  ) => void;
  onLayoutChange: (layout: Layout, activeItemId?: string) => void;
  onLayoutCommit: (layout: Layout, activeItemId?: string) => void;
  onEditWidget: (widget: DashboardWidget) => void;
  onDeleteWidget: (widget: DashboardWidget) => void;
  onDuplicateWidget: (widget: DashboardWidget) => void;
  readOnly?: boolean;
  builderMode?: boolean;
  refreshingWidgetIds?: Set<string>;
}) => {
  const [editingTitle, setEditingTitle] = useState(false);
  const [isExternalDragOver, setIsExternalDragOver] = useState(false);
  const [isCatalogDragActive, setIsCatalogDragActive] = useState(false);
  const [catalogDragPayload, setCatalogDragPayload] = useState<NewWidgetDragPayload | null>(null);
  const [externalDropPreview, setExternalDropPreview] = useState<Pick<DashboardLayoutItem, "x" | "y" | "w" | "h"> | null>(null);
  const isEditing = !readOnly;
  const isSectionTitleVisible = section.showTitle !== false;
  const { containerRef, width } = useContainerWidth({ initialWidth: 1280 });
  const gridRef = useRef<HTMLDivElement | null>(null);
  const suppressEditClickUntilRef = useRef(0);
  const draggingItemIdRef = useRef<string | undefined>(undefined);
  const externalDropStabilizeUntilRef = useRef(0);
  const sectionLayoutById = useMemo(() => toLayoutById(section), [section]);
  const sectionRglLayout = useMemo<Layout>(
    () => section.widgets.map((widget) => {
      const catalog = getWidgetCatalogByType(widget.props.widget_type);
      const base = sectionLayoutById[widget.id];
      return {
        i: widget.id,
        x: base?.x ?? 0,
        y: base?.y ?? 0,
        w: base?.w ?? catalog.defaultW,
        h: Math.max(catalog.minH, base?.h ?? catalog.minH),
        minW: catalog.minW,
        minH: catalog.minH,
        maxW: catalog.maxW,
        maxH: Number.POSITIVE_INFINITY,
      };
    }),
    [section.widgets, sectionLayoutById],
  );
  const sectionLayoutItems = useMemo<DashboardLayoutItem[]>(
    () => section.widgets.map((widget) => {
      const catalog = getWidgetCatalogByType(widget.props.widget_type);
      const base = sectionLayoutById[widget.id];
      return normalizeLayoutItem({
        i: widget.id,
        x: base?.x ?? 0,
        y: base?.y ?? 0,
        w: base?.w ?? catalog.defaultW,
        h: Math.max(catalog.minH, base?.h ?? catalog.defaultH),
      });
    }),
    [section.widgets, sectionLayoutById],
  );
  const occupiedColumns = useMemo(() => {
    const set = new Set<number>();
    sectionLayoutItems.forEach((item) => {
      const start = Math.max(0, item.x);
      const end = Math.min(SECTION_GRID_COLS, item.x + item.w);
      for (let column = start; column < end; column += 1) {
        set.add(column);
      }
    });
    return set;
  }, [sectionLayoutItems]);

  useEffect(() => {
    if (readOnly) return undefined;
    const handleCatalogDragState = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean; payload?: NewWidgetDragPayload }>).detail;
      const active = !!detail?.active;
      setIsCatalogDragActive(active);
      setCatalogDragPayload(active ? (detail?.payload || null) : null);
      if (!active) {
        setIsExternalDragOver(false);
        setExternalDropPreview(null);
      }
    };
    window.addEventListener(NEW_WIDGET_DRAG_STATE_EVENT, handleCatalogDragState as EventListener);
    return () => {
      window.removeEventListener(NEW_WIDGET_DRAG_STATE_EVENT, handleCatalogDragState as EventListener);
    };
  }, [readOnly]);

  const resolveIncomingDragPayload = (dataTransfer?: DataTransfer | null): NewWidgetDragPayload | null => (
    parseNewWidgetDragPayload(dataTransfer) || catalogDragPayload
  );

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="group/section">
      {(isSectionTitleVisible || !readOnly) && (
        <div className="mb-3 flex items-center gap-2">
          {isSectionTitleVisible && !readOnly && editingTitle ? (
            <Input
              autoFocus
              value={section.title}
              onChange={(event) => onChange({ ...section, title: event.target.value })}
              onBlur={() => setEditingTitle(false)}
              onKeyDown={(event) => event.key === "Enter" && setEditingTitle(false)}
              className="h-7 max-w-[300px] text-sm font-semibold"
              placeholder="Nome da seção"
            />
          ) : isSectionTitleVisible ? (
            <button
              type="button"
              onClick={() => !readOnly && setEditingTitle(true)}
              className="flex items-center gap-1 text-sm font-semibold"
            >
              {section.title || "Seção sem título"}
              {!readOnly && <Pencil className="h-3 w-3 opacity-0 transition-opacity group-hover/section:opacity-100" />}
            </button>
          ) : (
            !readOnly && <span className="text-xs font-medium text-muted-foreground">Título da seção oculto</span>
          )}

          <div className="flex-1" />

          {!readOnly && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 transition-opacity group-hover/section:opacity-100">
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onChange({ ...section, showTitle: section.showTitle === false })}>
                  {section.showTitle === false
                    ? <Eye className="mr-2 h-3.5 w-3.5" />
                    : <EyeOff className="mr-2 h-3.5 w-3.5" />}
                  {section.showTitle === false ? "Mostrar titulo" : "Ocultar titulo"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {index > 0 && (
                  <DropdownMenuItem onClick={() => onMove("up")}>
                    <ChevronUp className="mr-2 h-3.5 w-3.5" /> Mover para cima
                  </DropdownMenuItem>
                )}
                {index < total - 1 && (
                  <DropdownMenuItem onClick={() => onMove("down")}>
                    <ChevronDown className="mr-2 h-3.5 w-3.5" /> Mover para baixo
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
                  <Trash2 className="mr-2 h-3.5 w-3.5" /> Excluir seção
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}

      <div
        ref={containerRef}
        className={cn(
          "relative overflow-hidden rounded-xl transition-colors",
          isEditing
            ? cn(
              "builder-section-shell builder-section-shell--edit border border-dashed p-1.5",
              section.widgets.length === 0 ? "min-h-[220px]" : "min-h-0",
            )
            : "border border-transparent",
          isExternalDragOver && isEditing && "border-accent/65 bg-accent/5 shadow-[0_0_0_1px_hsl(var(--accent)/0.35)]",
        )}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setIsExternalDragOver(false);
            setExternalDropPreview(null);
          }
        }}
        onDragOver={(event) => {
          if (readOnly) return;
          const payload = resolveIncomingDragPayload(event.dataTransfer);
          if (!payload) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          const catalog = payload.preferredWidgetType
            ? getWidgetCatalogByType(payload.preferredWidgetType)
            : getWidgetCatalogByVisualization(payload.widgetType);
          const gridRect = gridRef.current?.getBoundingClientRect();
          const dropX = gridRect
            ? getDropXFromClientPoint(event.clientX, gridRect, width, catalog.minW)
            : 0;
          setIsExternalDragOver(true);
          setExternalDropPreview({
            x: dropX,
            y: 0,
            w: catalog.minW,
            h: catalog.minH,
          });
        }}
      >
        {isEditing && (
          <div className="builder-grid-guides pointer-events-none absolute inset-1.5 z-0 grid grid-cols-6 gap-4">
            {GRID_GUIDES.map((_, columnIndex) => (
              <div key={`guide-${section.id}-${columnIndex}`} className="builder-grid-guides__column" />
            ))}
          </div>
        )}

        <GridLayout
          innerRef={gridRef}
          width={width}
          compactor={horizontalCompactor}
          className={cn(
            "builder-section-grid relative z-10",
            isEditing && "builder-section-grid--edit",
            section.widgets.length === 0 && "min-h-[220px]",
          )}
          layout={sectionRglLayout}
          gridConfig={{
            cols: SECTION_GRID_COLS,
            rowHeight: GRID_ROW_HEIGHT,
            margin: [GRID_MARGIN_X, GRID_MARGIN_Y],
            containerPadding: [0, 0],
            maxRows: Number.POSITIVE_INFINITY,
          }}
          dragConfig={{
            enabled: !readOnly,
            bounded: true,
            handle: ".widget-drag-surface",
            cancel: "button,input,textarea,select,a,[role='button'],.widget-resize-handle,.widget-actions",
            threshold: 4,
          }}
          resizeConfig={{
            enabled: !readOnly,
            handles: ["w", "e", "s"],
            handleComponent: (axis, ref) => ((axis === "w" || axis === "e" || axis === "s")
              ? (
                <span
                  ref={ref}
                  className={cn(
                    "widget-resize-handle",
                    axis === "e" && "widget-resize-handle--right",
                    axis === "w" && "widget-resize-handle--left",
                    axis === "s" && "widget-resize-handle--bottom",
                  )}
                  aria-label={axis === "s" ? "Resize height" : "Resize width"}
                />
              )
              : null),
          }}
          dropConfig={{
            enabled: isEditing,
            defaultItem: { w: 1, h: 1 },
          }}
          onDropDragOver={(event) => {
            const payload = resolveIncomingDragPayload(event.dataTransfer);
            if (!payload) return false;
            setIsExternalDragOver(true);
            const catalog = payload.preferredWidgetType
              ? getWidgetCatalogByType(payload.preferredWidgetType)
              : getWidgetCatalogByVisualization(payload.widgetType);
            const clientPoint = getClientPointFromGridEvent(event);
            const gridRect = gridRef.current?.getBoundingClientRect();
            const dropX = clientPoint && gridRect
              ? getDropXFromClientPoint(clientPoint.x, gridRect, width, catalog.minW)
              : 0;
            setExternalDropPreview({
              x: dropX,
              y: 0,
              w: catalog.minW,
              h: catalog.minH,
            });
            return { w: catalog.minW, h: catalog.minH };
          }}
          onDrop={(_layout, item, event) => {
            const payload = resolveIncomingDragPayload((event as DragEvent).dataTransfer);
            draggingItemIdRef.current = undefined;
            externalDropStabilizeUntilRef.current = Date.now() + 220;
            setIsExternalDragOver(false);
            setExternalDropPreview(null);
            if (!payload) return;
            const catalog = payload.preferredWidgetType
              ? getWidgetCatalogByType(payload.preferredWidgetType)
              : getWidgetCatalogByVisualization(payload.widgetType);
            const clientPoint = getClientPointFromGridEvent(event);
            const gridRect = gridRef.current?.getBoundingClientRect();
            const pointerX = clientPoint && gridRect
              ? getDropXFromClientPoint(clientPoint.x, gridRect, width, catalog.minW)
              : null;
            const dropXRaw = typeof item?.x === "number" ? item.x : (pointerX ?? externalDropPreview?.x ?? 0);
            const dropX = Math.max(0, Math.min(SECTION_GRID_COLS - catalog.minW, Math.floor(dropXRaw)));
            onAddWidget(payload.widgetType, {
              x: dropX,
              y: 0,
              w: catalog.minW,
              h: catalog.minH,
            }, payload.preferredWidgetType);
          }}
          onLayoutChange={(nextLayout) => {
            if (!draggingItemIdRef.current && Date.now() < externalDropStabilizeUntilRef.current) return;
            onLayoutChange(nextLayout, draggingItemIdRef.current);
          }}
          onDragStart={(_layout, oldItem, newItem) => {
            externalDropStabilizeUntilRef.current = 0;
            draggingItemIdRef.current = newItem?.i || oldItem?.i || undefined;
            suppressEditClickUntilRef.current = Date.now() + 250;
            setIsExternalDragOver(false);
            setExternalDropPreview(null);
          }}
          onDrag={(_layout, oldItem, newItem) => {
            draggingItemIdRef.current = newItem?.i || oldItem?.i || draggingItemIdRef.current;
          }}
          onDragStop={(nextLayout, _oldItem, newItem) => {
            draggingItemIdRef.current = undefined;
            suppressEditClickUntilRef.current = Date.now() + 250;
            onLayoutCommit(nextLayout, newItem?.i);
          }}
          onResizeStop={(nextLayout, _oldItem, newItem) => onLayoutCommit(nextLayout, newItem?.i)}
        >
          {section.widgets.map((widget) => (
            <div key={widget.id} className="h-full">
              <WidgetCard
                dashboardId={dashboardId}
                datasetId={datasetId}
                nativeFilters={nativeFilters}
                widget={widget}
                layoutItem={sectionLayoutById[widget.id] || {
                  i: widget.id,
                  x: 0,
                  y: 0,
                  w: getWidgetCatalogByType(widget.props.widget_type).defaultW,
                  h: getWidgetCatalogByType(widget.props.widget_type).defaultH,
                }}
                readOnly={readOnly}
                builderMode={builderMode}
                isRefreshing={refreshingWidgetIds.has(widget.id)}
                shouldSuppressEditClick={() => Date.now() < suppressEditClickUntilRef.current}
                onEdit={() => onEditWidget(widget)}
                onDelete={() => onDeleteWidget(widget)}
                onDuplicate={() => onDuplicateWidget(widget)}
              />
            </div>
          ))}
        </GridLayout>

        {isEditing && isExternalDragOver && externalDropPreview && (
          <div className="pointer-events-none absolute inset-1.5 z-20">
            <div
              className="builder-section-external-drop-preview"
              style={toDropPreviewStyle(externalDropPreview, width)}
            />
          </div>
        )}

        {isEditing && (
          <div className="builder-grid-guides-actions pointer-events-none absolute inset-1.5 z-20 grid grid-cols-6 gap-4">
            {GRID_GUIDES.map((_, columnIndex) => (
              <div key={`guide-action-${section.id}-${columnIndex}`} className="builder-grid-guides__column builder-grid-guides__column--action pointer-events-none">
                {!occupiedColumns.has(columnIndex) && (
                  <div className="h-full">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className={cn(
                            "builder-grid-guides-column-trigger group",
                            isCatalogDragActive ? "pointer-events-none opacity-0" : "pointer-events-auto",
                          )}
                          aria-label={`Adicionar widget na coluna ${columnIndex + 1}`}
                          onDragEnter={(event) => {
                            const payload = resolveIncomingDragPayload(event.dataTransfer);
                            if (!payload) return;
                            event.preventDefault();
                            const catalog = payload.preferredWidgetType
                              ? getWidgetCatalogByType(payload.preferredWidgetType)
                              : getWidgetCatalogByVisualization(payload.widgetType);
                            const dropX = Math.max(0, Math.min(SECTION_GRID_COLS - catalog.minW, columnIndex));
                            setIsExternalDragOver(true);
                            setExternalDropPreview({
                              x: dropX,
                              y: 0,
                              w: catalog.minW,
                              h: catalog.minH,
                            });
                          }}
                          onDragOver={(event) => {
                            const payload = resolveIncomingDragPayload(event.dataTransfer);
                            if (!payload) return;
                            event.preventDefault();
                            event.stopPropagation();
                            event.dataTransfer.dropEffect = "copy";
                            const catalog = payload.preferredWidgetType
                              ? getWidgetCatalogByType(payload.preferredWidgetType)
                              : getWidgetCatalogByVisualization(payload.widgetType);
                            const dropX = Math.max(0, Math.min(SECTION_GRID_COLS - catalog.minW, columnIndex));
                            setIsExternalDragOver(true);
                            setExternalDropPreview({
                              x: dropX,
                              y: 0,
                              w: catalog.minW,
                              h: catalog.minH,
                            });
                          }}
                          onDragLeave={(event) => {
                            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                            setIsExternalDragOver(false);
                            setExternalDropPreview(null);
                          }}
                          onDrop={(event) => {
                            const payload = resolveIncomingDragPayload(event.dataTransfer);
                            if (!payload) return;
                            event.preventDefault();
                            event.stopPropagation();
                            const catalog = payload.preferredWidgetType
                              ? getWidgetCatalogByType(payload.preferredWidgetType)
                              : getWidgetCatalogByVisualization(payload.widgetType);
                            const dropX = Math.max(0, Math.min(SECTION_GRID_COLS - catalog.minW, columnIndex));
                            setIsExternalDragOver(false);
                            setExternalDropPreview(null);
                            onAddWidget(payload.widgetType, {
                              x: dropX,
                              y: 0,
                              w: catalog.minW,
                              h: catalog.minH,
                            }, payload.preferredWidgetType);
                          }}
                        >
                          <span className="sr-only">Adicionar widget</span>
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-44">
                        {WIDGET_CATALOG.map((entry) => {
                          const Icon = widgetTypeIconByWidget[entry.widgetType];
                          return (
                            <DropdownMenuItem
                              key={`${section.id}-${entry.id}-${columnIndex}`}
                              onClick={() => {
                                const catalog = getWidgetCatalogByType(entry.widgetType);
                                const targetW = catalog.minW;
                                const targetH = catalog.minH;
                                const x = Math.max(0, Math.min(SECTION_GRID_COLS - targetW, columnIndex));
                                onAddWidget(entry.visualizationType, {
                                  x,
                                  y: 0,
                                  w: targetW,
                                  h: targetH,
                                }, entry.widgetType);
                              }}
                            >
                              <Icon className="mr-2 h-3.5 w-3.5" />
                              {entry.title}
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {isEditing && isExternalDragOver && (
          <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-md border border-accent/55 bg-background/85 px-2 py-1 text-[11px] font-medium text-accent">
            Solte para adicionar widget
          </div>
        )}

      </div>

    </motion.div>
  );
};

export const DashboardCanvas = ({
  dashboardId,
  datasetId,
  nativeFilters,
  sections,
  onSectionsChange,
  onAddWidget,
  onEditWidget,
  onDeleteWidget,
  onDuplicateWidget,
  onAddSection,
  onCommitSectionLayout,
  readOnly = false,
  builderMode = false,
  refreshingWidgetIds = new Set(),
}: DashboardCanvasProps) => {
  const updateSection = (id: string, updated: DashboardSection) => {
    onSectionsChange(sections.map((section) => (section.id === id ? updated : section)));
  };

  const deleteSection = (id: string) => {
    onSectionsChange(sections.filter((section) => section.id !== id));
  };

  const moveSection = (index: number, dir: "up" | "down") => {
    const next = [...sections];
    const target = dir === "up" ? index - 1 : index + 1;
    [next[index], next[target]] = [next[target], next[index]];
    onSectionsChange(next);
  };

  const applyLayoutToSection = (sectionId: string, rglLayout: Layout, commit = false, activeItemId?: string) => {
    const targetSection = sections.find((section) => section.id === sectionId);
    if (!targetSection) return;
    const normalizedLayout = normalizeRglLayout(rglLayout, targetSection);
    const resolvedLayout = resolveSequentialLayout(normalizedLayout, targetSection, activeItemId);
    const layoutById = new Map(resolvedLayout.map((item) => [item.i, item]));
    const nextSections = sections.map((section) => {
      if (section.id !== sectionId) return section;
      return {
        ...section,
        columns: SECTION_GRID_COLS,
        layout: resolvedLayout,
        widgets: section.widgets.map((widget) => {
          const item = layoutById.get(widget.id);
          if (!item) return widget;
          const nextProps = {
            ...widget.props,
            size: {
              width: item.w as 1 | 2 | 3 | 4 | 5 | 6,
              height: gridRowsToWidgetHeight(item.h),
            },
          };
          return {
            ...widget,
            sectionId,
            type: nextProps.widget_type,
            props: nextProps,
            config: nextProps,
          };
        }),
      };
    });
    onSectionsChange(nextSections);
    if (commit) onCommitSectionLayout?.(sectionId, resolvedLayout);
  };

  return (
    <div data-tour="builder-canvas" className={cn("space-y-8", !readOnly && "builder-canvas builder-canvas--edit")}>
      <AnimatePresence>
        {sections.map((section, index) => (
          <SectionBlock
            key={section.id}
            dashboardId={dashboardId}
            datasetId={datasetId}
            nativeFilters={nativeFilters}
            section={section}
            index={index}
            total={sections.length}
            onChange={(next) => updateSection(section.id, next)}
            onDelete={() => deleteSection(section.id)}
            onMove={(dir) => moveSection(index, dir)}
            onAddWidget={(type, placement, preferredWidgetType) => onAddWidget(section.id, type, placement, preferredWidgetType)}
            onLayoutChange={(layout, activeItemId) => applyLayoutToSection(section.id, layout, false, activeItemId)}
            onLayoutCommit={(layout, activeItemId) => applyLayoutToSection(section.id, layout, true, activeItemId)}
            onEditWidget={onEditWidget}
            onDeleteWidget={onDeleteWidget}
            onDuplicateWidget={onDuplicateWidget}
            readOnly={readOnly}
            builderMode={builderMode}
            refreshingWidgetIds={refreshingWidgetIds}
          />
        ))}
      </AnimatePresence>

      {!readOnly && (
        <motion.button
          whileHover={{ scale: 1.002 }}
          whileTap={{ scale: 0.998 }}
          onClick={() => onAddSection()}
          className="w-full rounded-xl border-2 border-dashed border-border/50 py-3 text-sm font-medium text-muted-foreground transition-colors hover:border-accent/40 hover:text-accent"
        >
          <span className="inline-flex items-center gap-2">
            <Plus className="h-5 w-5" />
            Adicionar seção
          </span>
        </motion.button>
      )}
    </div>
  );
};
