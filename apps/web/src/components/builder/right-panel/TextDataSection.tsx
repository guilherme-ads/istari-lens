import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { DashboardWidget } from "@/types/dashboard";

export const TextWidgetDataSection = ({
  draft,
  setConfig,
}: {
  draft: DashboardWidget;
  setConfig: (patch: Partial<DashboardWidget["config"]>) => void;
}) => (
  <div className="space-y-2">
    <Label className="text-caption text-muted-foreground">Conteúdo</Label>
    <Textarea
      className="min-h-[140px] text-xs"
      value={draft.config.text_style?.content || ""}
      onChange={(event) => setConfig({
        text_style: {
          content: event.target.value,
          font_size: draft.config.text_style?.font_size || 18,
          align: draft.config.text_style?.align || "left",
        },
      })}
      placeholder="Digite o texto do widget..."
    />
  </div>
);

