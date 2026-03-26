import { AlertTriangle, CheckCircle2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

type JoinCondition = {
  leftColumn: string;
  rightColumn: string;
};

type JoinPropertiesPanelProps = {
  joinType: "inner" | "left" | "right";
  conditions: JoinCondition[];
  leftColumns: string[];
  rightColumns: string[];
  cardinality?: "1-1" | "1-N" | "N-1" | "N-N" | "indefinida";
  warnings?: string[];
  onChangeJoinType: (value: "inner" | "left" | "right") => void;
  onChangeCondition: (index: number, field: "leftColumn" | "rightColumn", value: string) => void;
  onAddCondition: () => void;
  onRemoveCondition: (index: number) => void;
};

const JoinPropertiesPanel = ({
  joinType,
  conditions,
  leftColumns,
  rightColumns,
  cardinality = "indefinida",
  warnings = [],
  onChangeJoinType,
  onChangeCondition,
  onAddCondition,
  onRemoveCondition,
}: JoinPropertiesPanelProps) => {
  const joinTypeLabel: Record<"inner" | "left" | "right", string> = {
    left: "LEFT",
    inner: "INNER",
    right: "RIGHT",
  };
  const supportedJoinTypes: Array<"left" | "inner"> = ["left", "inner"];

  return (
    <div className="space-y-3">
      <section className="space-y-2 rounded-xl border border-border/70 bg-card/45 p-3">
        <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Tipo do Join</Label>
        <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-background/40 p-1">
          {supportedJoinTypes.map((type) => (
            <button
              key={`join-type-${type}`}
              type="button"
              onClick={() => onChangeJoinType(type)}
              className={[
                "h-8 rounded-lg border px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide backdrop-blur-sm transition-colors",
                joinType === type
                  ? "border-accent/70 bg-accent/20 text-accent"
                  : "border-border/60 bg-transparent text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {joinTypeLabel[type]}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-2 rounded-xl border border-border/70 bg-card/45 p-3">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Condicoes</Label>
          <Button type="button" size="sm" variant="outline" className="h-8 rounded-xl text-caption" onClick={onAddCondition}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Condicao
          </Button>
        </div>

        {conditions.map((condition, index) => (
          <div key={`join-cond-${index}`} className="rounded-lg border border-border/60 bg-background/35 p-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Condicao {index + 1}</p>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 destructive-icon-btn"
                onClick={() => onRemoveCondition(index)}
                disabled={conditions.length <= 1}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="grid gap-1.5 md:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Origem</Label>
                <Select
                  value={condition.leftColumn || "__none__"}
                  onValueChange={(value) => onChangeCondition(index, "leftColumn", value === "__none__" ? "" : value)}
                >
                  <SelectTrigger className="h-8 rounded-lg text-caption">
                    <SelectValue placeholder="Coluna esquerda" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Selecione...</SelectItem>
                    {leftColumns.map((item) => (
                      <SelectItem key={`left-${item}`} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Destino</Label>
                <Select
                  value={condition.rightColumn || "__none__"}
                  onValueChange={(value) => onChangeCondition(index, "rightColumn", value === "__none__" ? "" : value)}
                >
                  <SelectTrigger className="h-8 rounded-lg text-caption">
                    <SelectValue placeholder="Coluna direita" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Selecione...</SelectItem>
                    {rightColumns.map((item) => (
                      <SelectItem key={`right-${item}`} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-2 rounded-xl border border-border/70 bg-card/45 p-3">
        <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Cardinalidade</Label>
        <div className="rounded-lg border border-border/60 bg-background/50 px-2 py-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Cardinalidade (estimada)</p>
          <p className="font-mono text-foreground">{cardinality}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">Heuristica local por nome de chave (id, *_pk, *_uuid).</p>
        </div>
      </section>

      <section className="space-y-2 rounded-xl border border-border/70 bg-card/45 p-3">
        <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Validacao</Label>
        {warnings.length > 0 ? (
          <div className="space-y-1.5">
            {warnings.map((warning) => (
              <Badge key={warning} variant="outline" className="w-full justify-start gap-1.5 border-warning/30 bg-warning/10 py-1 text-warning">
                <AlertTriangle className="h-3.5 w-3.5" />
                {warning}
              </Badge>
            ))}
          </div>
        ) : (
          <Badge variant="outline" className="w-full justify-start gap-1.5 border-success/30 bg-success/10 text-success">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Join saudavel
          </Badge>
        )}
      </section>
    </div>
  );
};

export default JoinPropertiesPanel;
