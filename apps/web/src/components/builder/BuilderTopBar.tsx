import { useState } from "react";
import {
  ChevronLeft,
  Database,
  Columns3,
  CircleHelp,
  Eye,
  Save,
  MoreHorizontal,
  Share2,
  Download,
  Upload,
  RefreshCw,
  Trash2,
  Check,
} from "lucide-react";

import type { View } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface BuilderTopBarProps {
  title: string;
  onTitleChange: (title: string) => void;
  titleOnboardingActive?: boolean;
  view: View;
  datasetName: string;
  widgetCount: number;
  sectionCount: number;
  isSaved: boolean;
  isPreview: boolean;
  onSave: () => void;
  onTogglePreview: () => void;
  onBack: () => void;
  onDelete: () => void;
  onShare: () => void;
  onExport: () => void;
  onImport: () => void;
  onRefreshData: () => void;
  onReplayOnboarding: () => void;
}

const formatRows = (value: number | undefined) => {
  if (!value || value <= 0) return "~0";
  if (value >= 1_000_000) return `~${Math.round(value / 1_000_000)}M`;
  return `~${Math.max(1, Math.round(value / 1000))}K`;
};

export const BuilderTopBar = ({
  title,
  onTitleChange,
  titleOnboardingActive = false,
  view,
  datasetName,
  widgetCount,
  sectionCount,
  isSaved,
  isPreview,
  onSave,
  onTogglePreview,
  onBack,
  onDelete,
  onShare,
  onExport,
  onImport,
  onRefreshData,
  onReplayOnboarding,
}: BuilderTopBarProps) => {
  const [editingTitle, setEditingTitle] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);

  return (
    <header className="h-12 border-b border-border bg-card/90 px-3 backdrop-blur-sm">
      <div className="flex h-full items-center gap-2">
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
        </Button>

        {editingTitle ? (
          <Input
            autoFocus
            data-tour="builder-dashboard-title"
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(event) => {
              if (event.key === "Enter") setEditingTitle(false);
            }}
            className={cn(
              "h-7 max-w-[220px] text-sm font-semibold bg-muted/30",
              titleOnboardingActive && "border-transparent focus-visible:ring-0 focus-visible:ring-offset-0",
            )}
            placeholder="Dashboard sem titulo"
          />
        ) : (
          <button
            type="button"
            data-tour="builder-dashboard-title"
            className="max-w-[220px] truncate text-sm font-semibold"
            onClick={() => setEditingTitle(true)}
          >
            {title || "Dashboard sem titulo"}
          </button>
        )}

        <Badge
          className={cn(
            "h-5 text-[10px] font-medium",
            isSaved
              ? "bg-success/10 text-success border-success/20"
              : "bg-warning/10 text-warning border-warning/20",
          )}
          variant="outline"
        >
          {isSaved ? "Salvo" : "Nao salvo"}
        </Badge>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <div className="hidden items-center gap-1 text-[11px] text-muted-foreground md:flex">
          <Database className="h-3 w-3" />
          <span>{datasetName}</span>
          <span>·</span>
          <Columns3 className="h-3 w-3" />
          <span>{(view.columns || []).length} colunas</span>
          <span>·</span>
          <span>{formatRows(view.rowCount)}</span>
        </div>

        <div className="flex-1" />

        <div className="hidden text-[11px] text-muted-foreground lg:block">
          {sectionCount} secoes · {widgetCount} widgets
        </div>

        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={onReplayOnboarding} aria-label="Ver onboarding novamente">
          <CircleHelp className="h-4 w-4" />
        </Button>

        <Button type="button" size="sm" variant={isPreview ? "default" : "outline"} className="h-8 text-xs gap-1.5" onClick={onTogglePreview}>
          <Eye className="h-3 w-3" />
          <span className="hidden sm:inline">{isPreview ? "Editar" : "Preview"}</span>
        </Button>

        <Button type="button" size="sm" className="h-8 text-xs gap-1.5 bg-accent text-accent-foreground hover:bg-accent/90" onClick={onSave}>
          <Save className="h-3 w-3" />
          <span className="hidden sm:inline">Salvar</span>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              onClick={() => {
                onShare();
                setShareCopied(true);
                window.setTimeout(() => setShareCopied(false), 2000);
              }}
            >
              {shareCopied ? <Check className="mr-2 h-3.5 w-3.5 text-success" /> : <Share2 className="mr-2 h-3.5 w-3.5" />}
              {shareCopied ? "Link copiado!" : "Compartilhar"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onExport}><Download className="mr-2 h-3.5 w-3.5" /> Exportar</DropdownMenuItem>
            <DropdownMenuItem onClick={onImport}><Upload className="mr-2 h-3.5 w-3.5" /> Importar</DropdownMenuItem>
            <DropdownMenuItem onClick={onRefreshData}><RefreshCw className="mr-2 h-3.5 w-3.5" /> Atualizar dados</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
              <Trash2 className="mr-2 h-3.5 w-3.5" /> Excluir dashboard
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
};

export default BuilderTopBar;
