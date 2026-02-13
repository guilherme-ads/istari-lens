import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Eye, EyeOff, AlertCircle, ArrowRight, Shield, BarChart3 } from "lucide-react";
import BrandLogo from "@/components/shared/BrandLogo";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import LoadingButton from "@/components/shared/LoadingButton";
import { api, ApiError } from "@/lib/api";
import { setAuthSession } from "@/lib/auth";

const LoginPage = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!email || !password) {
      setError("Por favor, preencha todos os campos.");
      return;
    }
    setLoading(true);
    try {
      const response = await api.login(email, password);
      setAuthSession(response.access_token, response.user, rememberMe);
      navigate("/home");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.detail || "Falha ao autenticar.");
      } else {
        setError("Falha ao autenticar.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background px-4">
      {/* Decorative background */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-1/4 -right-1/4 h-[600px] w-[600px] rounded-full bg-accent/5 blur-3xl" />
        <div className="absolute -bottom-1/4 -left-1/4 h-[500px] w-[500px] rounded-full bg-accent/3 blur-3xl" />
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: `radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)`,
            backgroundSize: "32px 32px",
          }}
        />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="relative z-10 w-full max-w-[400px]"
      >
        {/* Brand */}
        <div className="mb-8 flex flex-col items-center gap-4">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.15, duration: 0.4 }}
            className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent shadow-elevated"
          >
            <BarChart3 className="h-7 w-7 text-accent-foreground" />
          </motion.div>
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Bem-vindo ao <BrandLogo size="lg" className="inline" />
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Entre com suas credenciais para acessar a plataforma
            </p>
          </div>
        </div>

        {/* Form card */}
        <div className="glass-card p-6 space-y-5">
          {/* Error */}
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-start gap-2.5 rounded-lg bg-destructive/10 border border-destructive/20 px-3.5 py-3 text-sm text-destructive"
            >
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </motion.div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-medium">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="seu@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="h-10"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-sm font-medium">
                Senha
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  className="h-10 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="remember"
                checked={rememberMe}
                onCheckedChange={(v) => setRememberMe(v === true)}
              />
              <Label htmlFor="remember" className="text-sm text-muted-foreground font-normal cursor-pointer">
                Manter conectado
              </Label>
            </div>

            <LoadingButton
              type="submit"
              loading={loading}
              loadingText="Entrando…"
              className="w-full h-10 bg-accent text-accent-foreground hover:bg-accent/90 font-semibold"
            >
              Entrar
              <ArrowRight className="ml-2 h-4 w-4" />
            </LoadingButton>
          </form>
        </div>

        {/* Footer */}
        <div className="mt-6 flex flex-col items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Shield className="h-3 w-3" />
            Conexão segura e criptografada
          </div>
          <p className="text-center text-xs text-muted-foreground/60">
            {/* Cliente pediu remover "istari" do texto visivel; para reverter, restaurar "istari Lens". */}
            © 2026 Lens App · Data Intelligence Platform
          </p>
        </div>
      </motion.div>
    </div>
  );
};

export default LoginPage;

