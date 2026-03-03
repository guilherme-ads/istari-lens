import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  User,
  Mail,
  Shield,
  Key,
  Save,
  Eye,
  EyeOff,
  Calendar,
  Clock,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { api, ApiError } from "@/lib/api";
import { getStoredUser, updateStoredUser } from "@/lib/auth";

const getPasswordStrength = (password: string) => {
  if (!password) return { score: 0, label: "" };
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  if (score <= 1) return { score: 20, label: "Muito fraca" };
  if (score === 2) return { score: 40, label: "Fraca" };
  if (score === 3) return { score: 60, label: "Razoável" };
  if (score === 4) return { score: 80, label: "Forte" };
  return { score: 100, label: "Muito forte" };
};

const formatDateTimeBR = (value?: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const AccountPage = () => {
  const { toast } = useToast();
  const storedUser = getStoredUser();
  const isAdmin = !!storedUser?.is_admin;
  const [fullName, setFullName] = useState(storedUser?.full_name || "");
  const [email, setEmail] = useState(storedUser?.email || "");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const meQuery = useQuery({
    queryKey: ["auth-me"],
    queryFn: () => api.getMe(),
  });

  useEffect(() => {
    const data = meQuery.data;
    if (!data) return;
    setFullName(data.full_name || "");
    setEmail(data.email);
    const current = getStoredUser();
    updateStoredUser({
      id: current?.id || data.id,
      email: data.email,
      full_name: data.full_name,
      is_admin: current?.is_admin ?? data.is_admin,
    });
  }, [meQuery.data]);

  const updateProfile = useMutation({
    mutationFn: () =>
      api.updateMe({
        full_name: fullName.trim() || undefined,
        ...(isAdmin ? { email: email.trim() } : {}),
      }),
    onSuccess: (data) => {
      const current = getStoredUser();
      updateStoredUser({
        id: current?.id || data.id,
        email: data.email,
        full_name: data.full_name,
        is_admin: current?.is_admin ?? data.is_admin,
      });
      toast({ title: "Perfil atualizado", description: "Seus dados foram salvos com sucesso." });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao salvar perfil";
      toast({ title: "Erro ao atualizar perfil", description: message, variant: "destructive" });
    },
  });

  const changePassword = useMutation({
    mutationFn: () =>
      api.changePassword({
        current_password: currentPassword,
        new_password: newPassword,
      }),
    onSuccess: () => {
      toast({ title: "Senha alterada", description: "Sua senha foi redefinida com sucesso." });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao alterar senha";
      toast({ title: "Erro ao alterar senha", description: message, variant: "destructive" });
    },
  });

  const strength = useMemo(() => getPasswordStrength(newPassword), [newPassword]);
  const passwordsMatch = confirmPassword.length > 0 && newPassword === confirmPassword;
  const passwordsMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const canSubmitPassword = !!currentPassword && newPassword.length >= 8 && passwordsMatch;

  const profileDirty =
    fullName.trim() !== (meQuery.data?.full_name || "").trim() ||
    (isAdmin && email.trim().toLowerCase() !== (meQuery.data?.email || "").trim().toLowerCase());

  const handleResetPassword = () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      toast({ title: "Campos obrigatórios", description: "Preencha todos os campos de senha.", variant: "destructive" });
      return;
    }
    if (newPassword !== confirmPassword) {
      toast({ title: "Senhas não coincidem", description: "A nova senha e a confirmação devem ser iguais.", variant: "destructive" });
      return;
    }
    if (newPassword.length < 8) {
      toast({ title: "Senha fraca", description: "A nova senha deve ter pelo menos 8 caracteres.", variant: "destructive" });
      return;
    }
    changePassword.mutate();
  };

  const roleLabel = storedUser?.is_admin ? "Administrador" : "Usuário";
  const initials =
    (fullName || email)
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("") || "U";

  return (
    <div className="bg-background min-h-full">
      <main className="container max-w-3xl py-8 space-y-8">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Minha conta</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Gerencie seus dados pessoais e segurança.
          </p>
        </motion.div>

        <div className="space-y-6">
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-card p-6">
            <div className="flex items-start gap-5">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-accent/10 border border-accent/20">
                <span className="text-xl font-bold text-accent">{initials}</span>
              </div>

              <div className="flex-1 min-w-0 space-y-2">
                <div>
                  <h2 className="text-lg font-semibold text-foreground truncate">{fullName || "-"}</h2>
                  <p className="text-sm text-muted-foreground truncate">{email || "-"}</p>
                </div>

                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <Badge variant="secondary" className="gap-1 font-medium">
                    <Shield className="h-3 w-3" />
                    {roleLabel}
                  </Badge>
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    Membro desde {formatDateTimeBR(meQuery.data?.created_at)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Último acesso: {formatDateTimeBR(meQuery.data?.last_login_at)}
                  </span>
                </div>
              </div>
            </div>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-card">
            <div className="p-6 pb-4">
              <div className="flex items-center gap-2 mb-1">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10">
                  <User className="h-3.5 w-3.5 text-accent" />
                </div>
                <h3 className="text-sm font-semibold text-foreground">Informações do perfil</h3>
              </div>
              <p className="text-xs text-muted-foreground ml-9">Atualize seus dados pessoais.</p>
            </div>

            <Separator />

            <div className="p-6 space-y-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="name" className="text-xs text-muted-foreground">Nome completo</Label>
                  <Input
                    id="name"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    disabled={meQuery.isLoading}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="email" className="text-xs text-muted-foreground">E-mail</Label>
                  <div className="relative">
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={meQuery.isLoading || !isAdmin}
                      className="pr-9"
                    />
                    <Mail className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
                  </div>
                  {!isAdmin && (
                    <p className="text-[11px] text-muted-foreground">Somente administradores podem alterar e-mail.</p>
                  )}
                </div>
              </div>

              <div className="flex justify-end">
                <Button
                  onClick={() => updateProfile.mutate()}
                  size="sm"
                  className="gap-1.5"
                  disabled={!profileDirty || updateProfile.isPending || meQuery.isLoading}
                >
                  <Save className="h-3.5 w-3.5" />
                  {updateProfile.isPending ? "Salvando..." : "Salvar alterações"}
                </Button>
              </div>
            </div>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-card">
            <div className="p-6 pb-4">
              <div className="flex items-center gap-2 mb-1">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10">
                  <Key className="h-3.5 w-3.5 text-accent" />
                </div>
                <h3 className="text-sm font-semibold text-foreground">Alterar senha</h3>
              </div>
              <p className="text-xs text-muted-foreground ml-9">Redefina sua senha de acesso à plataforma.</p>
            </div>

            <Separator />

            <div className="p-6 space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="current-password" className="text-xs text-muted-foreground">Senha atual</Label>
                <div className="relative">
                  <Input
                    id="current-password"
                    type={showCurrent ? "text" : "password"}
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="********"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCurrent(!showCurrent)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={showCurrent ? "Ocultar senha" : "Mostrar senha"}
                  >
                    {showCurrent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="new-password" className="text-xs text-muted-foreground">Nova senha</Label>
                  <div className="relative">
                    <Input
                      id="new-password"
                      type={showNew ? "text" : "password"}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Mínimo 8 caracteres"
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNew(!showNew)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      aria-label={showNew ? "Ocultar senha" : "Mostrar senha"}
                    >
                      {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>

                  {newPassword && (
                    <div className="space-y-1 pt-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground">Força da senha</span>
                        <span className="text-[11px] font-medium text-muted-foreground">{strength.label}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-accent transition-all duration-300"
                          style={{ width: `${strength.score}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="confirm-password" className="text-xs text-muted-foreground">Confirmar nova senha</Label>
                  <Input
                    id="confirm-password"
                    type={showNew ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repita a nova senha"
                  />

                  {confirmPassword && (
                    <div className="flex items-center gap-1 pt-1">
                      {passwordsMatch ? (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                          <span className="text-[11px] text-emerald-600 font-medium">Senhas coincidem</span>
                        </>
                      ) : (
                        <>
                          <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                          <span className="text-[11px] text-destructive font-medium">Senhas não coincidem</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex justify-end">
                <Button
                  onClick={handleResetPassword}
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={!canSubmitPassword || changePassword.isPending}
                >
                  <Key className="h-3.5 w-3.5" />
                  {changePassword.isPending ? "Redefinindo..." : "Redefinir senha"}
                </Button>
              </div>
            </div>
          </motion.div>
        </div>
      </main>
    </div>
  );
};

export default AccountPage;
