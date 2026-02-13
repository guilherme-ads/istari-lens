import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Database, Layers, LayoutDashboard, ArrowRight,
  Share2, Shield, Zap, Eye, BarChart3, Database as DatabaseIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import BrandLogo from "@/components/shared/BrandLogo";
import EmptyState from "@/components/shared/EmptyState";
import { useCoreData } from "@/hooks/use-core-data";

const features = [
  {
    icon: Database,
    title: "Datasources",
    desc: "Conecte múltiplas fontes de dados e sincronize automaticamente.",
  },
  {
    icon: Layers,
    title: "Datasets",
    desc: "Organize suas views em datasets temáticos para análise focada.",
  },
  {
    icon: LayoutDashboard,
    title: "Dashboards",
    desc: "Monte dashboards interativos com KPIs, gráficos e tabelas.",
  },
  {
    icon: Share2,
    title: "Compartilhamento",
    desc: "Compartilhe insights com sua equipe por links públicos.",
  },
];

const HomePage = () => {
  const navigate = useNavigate();
  const { datasources, views, datasets, dashboards, isLoading, isError, errorMessage } = useCoreData();

  const stats = [
    { label: "Datasources", value: datasources.filter((d) => d.status === "active").length },
    { label: "Views ativas", value: views.filter((v) => v.status === "active").length },
    { label: "Datasets", value: datasets.length },
    { label: "Dashboards", value: dashboards.length },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <header className="sticky top-0 z-50 border-b border-border bg-card/80 backdrop-blur-md">
        <div className="container flex h-14 items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent shadow-sm">
              {/* Cliente pediu usar o mesmo icone padrao das outras telas; para reverter, restaurar "iL". */}
              <BarChart3 className="h-4 w-4 text-accent-foreground" />
            </div>
            <BrandLogo size="lg" className="text-foreground" />
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="text-sm" onClick={() => navigate("/login")}>
              Entrar
            </Button>
            <Button size="sm" className="bg-accent text-accent-foreground hover:bg-accent/90 text-sm" onClick={() => navigate("/login")}>
              Começar agora
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        {/* Decorative background */}
        <div className="absolute inset-0 -z-10">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[500px] rounded-full bg-accent/5 blur-3xl" />
          <div className="absolute bottom-0 right-0 w-[400px] h-[300px] rounded-full bg-accent/3 blur-3xl" />
        </div>

        <div className="container py-20 md:py-32">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="max-w-3xl mx-auto text-center space-y-6"
          >
            <div className="inline-flex items-center gap-2 rounded-full bg-accent/10 px-4 py-1.5 text-xs font-semibold text-accent">
              <Zap className="h-3 w-3" />
              Análise de dados simplificada
            </div>

            <h1 className="text-4xl md:text-5xl lg:text-6xl font-extrabold tracking-tight text-foreground leading-[1.1]">
              Transforme dados em{" "}
              <span className="text-accent">decisões</span>
            </h1>

            <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              Conecte suas fontes de dados, crie datasets e monte dashboards interativos — tudo sem escrever código.
            </p>

            <div className="flex items-center justify-center gap-3 pt-2">
              <Button
                size="lg"
                className="bg-accent text-accent-foreground hover:bg-accent/90 h-12 px-8 text-base font-semibold"
                onClick={() => navigate("/datasets")}
              >
                Explorar Datasets
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-12 px-8 text-base"
                onClick={() => navigate("/admin")}
              >
                Gerenciar Fontes
              </Button>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Stats */}
      <section className="border-y border-border bg-card/50">
        <div className="container py-8">
          {isError ? (
            <EmptyState
              icon={<DatabaseIcon className="h-5 w-5" />}
              title="Erro ao carregar dados"
              description={errorMessage}
            />
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
              {stats.map((stat, i) => (
                <motion.div
                  key={stat.label}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 + i * 0.08 }}
                  className="text-center"
                >
                  <p className="text-3xl md:text-4xl font-extrabold text-foreground">
                    {isLoading ? "..." : stat.value}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">{stat.label}</p>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Features */}
      <section className="container py-16 md:py-24">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-12"
        >
          <h2 className="text-2xl md:text-3xl font-bold text-foreground">
            Tudo que você precisa para analisar dados
          </h2>
          <p className="text-muted-foreground mt-2 max-w-lg mx-auto">
            Do datasource ao dashboard, uma experiência integrada e sem fricção.
          </p>
        </motion.div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f, i) => (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08, duration: 0.4 }}
              className="glass-card p-6 flex flex-col gap-4 group hover:shadow-lg transition-shadow"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent group-hover:bg-accent group-hover:text-accent-foreground transition-colors">
                <f.icon className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground">{f.title}</h3>
                <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{f.desc}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-border bg-muted/30">
        <div className="container py-16 md:py-24">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-12"
          >
            <h2 className="text-2xl md:text-3xl font-bold text-foreground">Como funciona</h2>
            <p className="text-muted-foreground mt-2">Três passos para seus insights</p>
          </motion.div>

          <div className="grid gap-8 md:grid-cols-3 max-w-4xl mx-auto">
            {[
              { step: "01", title: "Conecte", desc: "Registre seus datasources e sincronize as views automaticamente.", icon: Database },
              { step: "02", title: "Organize", desc: "Crie datasets associando views aos contextos de análise.", icon: Eye },
              { step: "03", title: "Visualize", desc: "Monte dashboards com widgets interativos e compartilhe.", icon: LayoutDashboard },
            ].map((item, i) => (
              <motion.div
                key={item.step}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.12 }}
                className="text-center space-y-3"
              >
                <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent mx-auto">
                  <item.icon className="h-6 w-6" />
                </div>
                <span className="block text-xs font-bold text-accent uppercase tracking-widest">Passo {item.step}</span>
                <h3 className="text-lg font-bold text-foreground">{item.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="container py-16 md:py-24">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="glass-card p-8 md:p-12 text-center max-w-2xl mx-auto"
        >
          <Shield className="h-8 w-8 text-accent mx-auto mb-4" />
          <h2 className="text-2xl md:text-3xl font-bold text-foreground">
            Pronto para começar?
          </h2>
          <p className="text-muted-foreground mt-2 mb-6 max-w-md mx-auto">
            Explore os datasets disponíveis e crie seu primeiro dashboard em minutos.
          </p>
          <Button
            size="lg"
            className="bg-accent text-accent-foreground hover:bg-accent/90 h-12 px-8 text-base font-semibold"
            onClick={() => navigate("/datasets")}
          >
            Começar agora <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
        </motion.div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border bg-card/50">
        <div className="container py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <BrandLogo size="sm" className="text-foreground" />
          {/* Cliente pediu remover "istari" do texto visivel; para reverter, restaurar "istari Lens". */}
          <p>© 2026 Lens App. Todos os direitos reservados.</p>
        </div>
      </footer>
    </div>
  );
};

export default HomePage;
