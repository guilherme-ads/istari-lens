import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

import type { DashboardSection, DashboardWidget } from "@/types/dashboard";

type ExportDashboardPdfParams = {
  dashboardTitle: string;
  datasetLabel?: string;
  sections: DashboardSection[];
  fileName?: string;
  dataByWidgetId?: Record<string, { columns: string[]; rows: Record<string, unknown>[]; row_count: number }>;
  appliedFilters?: Array<{ column: string; op: string; value: string | string[] }>;
};

type PositionedWidget = {
  widget: DashboardWidget;
  span: number;
  startCol: number;
};

type WidgetRow = {
  items: PositionedWidget[];
};

const buildSectionRows = (section: DashboardSection): WidgetRow[] => {
  const rows: WidgetRow[] = [];
  let currentItems: PositionedWidget[] = [];
  let used = 0;

  const flush = () => {
    if (currentItems.length > 0) {
      rows.push({ items: currentItems });
      currentItems = [];
      used = 0;
    }
  };

  for (const widget of section.widgets) {
    const columns = section.columns;
    const baseSpan = widget.config.size?.width || 1;
    const span = Math.max(1, Math.min(columns, baseSpan));

    if (used + span > columns) {
      flush();
    }

    currentItems.push({ widget, span, startCol: used });
    used += span;
    if (used >= columns) {
      flush();
    }
  }

  flush();
  return rows;
};

const captureWidgetCanvas = async (widgetId: string): Promise<HTMLCanvasElement | null> => {
  const element = document.querySelector<HTMLElement>(`[data-pdf-widget-id="${widgetId}"]`);
  if (!element) return null;

  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    backgroundColor: "#ffffff",
    logging: false,
    windowWidth: document.documentElement.scrollWidth,
  });
  return canvas;
};

const drawCanvasImage = (
  doc: jsPDF,
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  width: number,
  height: number,
) => {
  const image = canvas.toDataURL("image/png", 1.0);
  doc.addImage(image, "PNG", x, y, width, height, undefined, "FAST");
};

const drawSplitTableCanvas = (
  doc: jsPDF,
  canvas: HTMLCanvasElement,
  x: number,
  yStart: number,
  width: number,
  pageBottom: number,
  marginTop: number,
): number => {
  const pxToMm = width / canvas.width;
  const totalHeightMm = canvas.height * pxToMm;

  let remainingHeightMm = totalHeightMm;
  let sourceOffsetPx = 0;
  let y = yStart;

  while (remainingHeightMm > 0) {
    const availableMm = Math.max(10, pageBottom - y);
    const chunkMm = Math.min(availableMm, remainingHeightMm);
    const chunkPx = Math.max(1, Math.floor(chunkMm / pxToMm));

    const chunkCanvas = document.createElement("canvas");
    chunkCanvas.width = canvas.width;
    chunkCanvas.height = chunkPx;
    const ctx = chunkCanvas.getContext("2d");
    if (!ctx) break;

    ctx.drawImage(
      canvas,
      0,
      sourceOffsetPx,
      canvas.width,
      chunkPx,
      0,
      0,
      canvas.width,
      chunkPx,
    );

    drawCanvasImage(doc, chunkCanvas, x, y, width, chunkMm);

    remainingHeightMm -= chunkMm;
    sourceOffsetPx += chunkPx;

    if (remainingHeightMm > 0) {
      doc.addPage("a4", "landscape");
      y = marginTop;
    } else {
      y += chunkMm;
    }
  }

  return y;
};

export const exportDashboardToPdf = async (params: ExportDashboardPdfParams): Promise<void> => {
  const { dashboardTitle, datasetLabel, sections, fileName } = params;

  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const marginX = 10;
  const marginY = 10;
  const gap = 4;

  let y = marginY;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(dashboardTitle, marginX, y);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(
    `${datasetLabel ? `Dataset: ${datasetLabel}  |  ` : ""}${new Date().toLocaleString("pt-BR")}`,
    marginX,
    y + 5,
  );
  y += 10;

  const pageBottom = pageH - marginY;

  const ensureSpace = (requiredHeight: number) => {
    if (y + requiredHeight <= pageBottom) return;
    doc.addPage("a4", "landscape");
    y = marginY;
  };

  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const section = sections[sectionIndex];
    const rows = buildSectionRows(section);

    if (section.showTitle !== false) {
      ensureSpace(10);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.text(section.title || `Secao ${sectionIndex + 1}`, marginX, y);
      y += 5;
    }

    const contentW = pageW - marginX * 2;
    const colW = (contentW - (section.columns - 1) * gap) / section.columns;

    for (const row of rows) {
      const captures = await Promise.all(
        row.items.map(async (item) => {
          const canvas = await captureWidgetCanvas(item.widget.id);
          if (!canvas) return null;
          const width = item.span * colW + (item.span - 1) * gap;
          const height = width * (canvas.height / canvas.width);
          return { item, canvas, width, height };
        }),
      );
      const valid = captures.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      if (valid.length === 0) continue;

      const nonTableHeights = valid
        .filter((entry) => entry.item.widget.config.widget_type !== "table")
        .map((entry) => entry.height);
      const rowHeight = nonTableHeights.length > 0 ? Math.max(...nonTableHeights) : 0;

      if (rowHeight > 0) {
        ensureSpace(rowHeight + 2);
      }

      const rowStartY = y;
      let rowEndY = y;

      for (const entry of valid) {
        const x = marginX + entry.item.startCol * (colW + gap);

        if (entry.item.widget.config.widget_type === "table") {
          const tableEndY = drawSplitTableCanvas(doc, entry.canvas, x, rowStartY, entry.width, pageBottom, marginY);
          rowEndY = Math.max(rowEndY, tableEndY);
          continue;
        }

        drawCanvasImage(doc, entry.canvas, x, rowStartY, entry.width, entry.height);
        rowEndY = Math.max(rowEndY, rowStartY + entry.height);
      }

      y = rowEndY + 4;
    }

    y += 2;
  }

  const outputName =
    fileName || `${dashboardTitle.replace(/\s+/g, "_").toLowerCase()}_${new Date().toISOString().slice(0, 10)}.pdf`;
  doc.save(outputName);
};
