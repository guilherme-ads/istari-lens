import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ExternalLink, Download, Calendar, Database, TrendingUp } from "lucide-react";
import BrandLogo from "@/components/shared/BrandLogo";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip, ResponsiveContainer,
} from "recharts";
import { api } from "@/lib/api";
import EmptyState from "@/components/shared/EmptyState";

const tooltipStyle = {
  borderRadius: 8,
  border: "1px solid hsl(214, 20%, 88%)",
  fontSize: 12,
  boxShadow: "0 4px 12px -2px rgba(0,0,0,0.08)",
};

const SharedAnalysisPage = () => {
  const { shareToken } = useParams();

  const sharedQuery = useQuery({
    queryKey: ["shared-analysis", shareToken],
    queryFn: () => api.getSharedAnalysis(String(shareToken)),
    enabled: !!shareToken,
  });

  const rows = sharedQuery.data?.data.rows || [];
  const columns = sharedQuery.data?.data.columns || [];

  const numericColumns = useMemo(
    () => (rows[0] ? Object.keys(rows[0]).filter((key) => typeof rows[0][key] === "number") : []),
    [rows],
  );
  const textColumns = useMemo(
    () => (rows[0] ? Object.keys(rows[0]).filter((key) => typeof rows[0][key] === "string") : []),
    [rows],
  );

  const xKey = textColumns[0] || columns[0];
  const yKey = numericColumns[0] || columns[1];

  const totalMetric = useMemo(() => {
    if (!yKey) return 0;
    return rows.reduce((sum, row) => sum + (Number(row[yKey] || 0) || 0), 0);
  }, [rows, yKey]);

  if (sharedQuery.isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <main className="container py-8 max-w-5xl">
          <EmptyState icon={<Database className="h-5 w-5" />} title="Carregando analise" description="Aguarde enquanto buscamos os dados compartilhados." />
        </main>
      </div>
    );
  }

  if (sharedQuery.isError || !sharedQuery.data) {
    return (
      <div className="min-h-screen bg-background">
        <main className="container py-8 max-w-5xl">
          <EmptyState icon={<Database className="h-5 w-5" />} title="Analise não encontrada" description={(sharedQuery.error as Error | undefined)?.message || "Token invalido ou expirado."} />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border bg-card/80 backdrop-blur-sm">
        <div className="container flex h-12 items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent">
              <span className="text-xs font-extrabold text-accent-foreground">iL</span>
            </div>
            <BrandLogo size="sm" className="text-foreground" />
            <span className="h-4 w-px bg-border" />
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <ExternalLink className="h-3 w-3" /> Analise compartilhada
            </span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5">
                <Download className="h-3 w-3" />
                <span className="hidden sm:inline">Exportar</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent className="text-xs">Exportar dados</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <main className="container py-8 max-w-5xl">
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">{sharedQuery.data.analysis.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                Compartilhado em {new Date(sharedQuery.data.analysis.created_at).toLocaleDateString("pt-BR")}
              </span>
              <span className="flex items-center gap-1">
                <Database className="h-3 w-3" />
                Dataset ID {sharedQuery.data.analysis.dataset_id}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <KpiMiniCard label={yKey || "Metrica"} value={totalMetric.toLocaleString()} icon={TrendingUp} />
            <KpiMiniCard label="Registros" value={rows.length.toLocaleString()} icon={TrendingUp} />
            <KpiMiniCard label="Colunas" value={columns.length.toLocaleString()} icon={TrendingUp} />
          </div>

          <div className="glass-card p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-foreground">Visualização</h2>
              <span className="text-xs text-muted-foreground">{rows.length} registros</span>
            </div>
            {xKey && yKey ? (
              <ResponsiveContainer width="100%" height={350}>
                <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(214, 20%, 88%)" vertical={false} />
                  <XAxis dataKey={xKey} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={60} />
                  <ReTooltip contentStyle={tooltipStyle} />
                  <Bar dataKey={yKey} fill="hsl(174, 62%, 38%)" radius={[6, 6, 0, 0]} maxBarSize={48} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState icon={<Database className="h-5 w-5" />} title="Sem dados para grafico" description="Não foi possivel identificar colunas para visualização." />
            )}
          </div>

          <div className="glass-card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h2 className="text-sm font-semibold text-foreground">Dados detalhados</h2>
              <span className="text-xs text-muted-foreground">{rows.length} registros</span>
            </div>
            {rows.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">Nenhum dado retornado.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    {Object.keys(rows[0]).map((k) => (
                      <TableHead key={k} className="text-xs font-semibold whitespace-nowrap">{k}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, i) => (
                    <TableRow key={i}>
                      {Object.entries(row).map(([key, v], j) => (
                        <TableCell key={j} className={`text-sm ${typeof v === "number" ? "font-mono text-right tabular-nums" : ""}`}>
                          {typeof v === "number" ? v.toLocaleString() : String(v)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <div className="flex flex-col items-center gap-2 pt-4 pb-8">
            <BrandLogo size="sm" className="text-muted-foreground" />
            <p className="text-[11px] text-muted-foreground/60">
              Data Intelligence Platform . {shareToken && `Ref: ${shareToken}`}
            </p>
          </div>
        </motion.div>
      </main>
    </div>
  );
};

const KpiMiniCard = ({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof TrendingUp;
}) => (
  <motion.div
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    className="glass-card p-4 flex items-start gap-3"
  >
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
      <Icon className="h-4 w-4" />
    </div>
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-xl font-bold tracking-tight text-foreground leading-tight">{value}</p>
    </div>
  </motion.div>
);

export default SharedAnalysisPage;
