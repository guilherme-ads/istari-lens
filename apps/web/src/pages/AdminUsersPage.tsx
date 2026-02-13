import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Eye, Pencil, Plus, Search, Trash2, Users } from "lucide-react";

import ConfirmDialog from "@/components/shared/ConfirmDialog";
import EmptyState from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { ApiAdminUser, ApiError, api } from "@/lib/api";
import { getStoredUser } from "@/lib/auth";

type SortField = "name" | "email" | "created_at" | "updated_at" | "last_login_at" | "role";
type SortDir = "asc" | "desc";

const PAGE_SIZE = 10;

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

const AdminUsersPage = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const currentUser = getStoredUser();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [sortField, setSortField] = useState<SortField>("updated_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailUser, setDetailUser] = useState<ApiAdminUser | null>(null);
  const [editUser, setEditUser] = useState<ApiAdminUser | null>(null);
  const [deleteUser, setDeleteUser] = useState<ApiAdminUser | null>(null);

  const listQuery = useQuery({
    queryKey: ["admin-users", search, page, sortField, sortDir],
    queryFn: () => api.listAdminUsers({ search, page, page_size: PAGE_SIZE, sort: `${sortField}:${sortDir}` }),
  });

  const users = listQuery.data?.items || [];
  const total = listQuery.data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const createMutation = useMutation({
    mutationFn: (payload: { name: string; email: string; role: "ADMIN" | "USER"; is_active: boolean; password: string }) =>
      api.createAdminUser(payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setCreateOpen(false);
      toast({ title: "Usuário criado com sucesso" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao criar usuário";
      toast({ title: "Erro ao criar usuário", description: message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: Partial<{ name: string; email: string; role: "ADMIN" | "USER"; is_active: boolean }> }) =>
      api.updateAdminUser(id, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setEditUser(null);
      toast({ title: "Usuário atualizado" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao atualizar usuário";
      toast({ title: "Erro ao atualizar usuário", description: message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteAdminUser(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setDeleteUser(null);
      toast({ title: "Usuário excluído" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.detail || error.message : "Falha ao excluir usuário";
      toast({ title: "Erro ao excluir usuário", description: message, variant: "destructive" });
    },
  });

  const tableError = (listQuery.error as Error | undefined)?.message || "Erro ao carregar usuários";
  const canPrev = page > 1;
  const canNext = page < totalPages;

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortField(field);
    setSortDir("asc");
  };

  const stats = useMemo(() => {
    const adminCount = users.filter((user) => user.role === "ADMIN").length;
    const activeCount = users.filter((user) => user.is_active).length;
    return { adminCount, activeCount };
  }, [users]);

  return (
    <div className="bg-background">
      <main className="container py-6 space-y-6">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Usuários</h1>
            <p className="mt-1 text-sm text-muted-foreground">Gerencie logins e permissões da plataforma.</p>
          </div>
          <Button className="bg-accent text-accent-foreground hover:bg-accent/90" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Novo usuário
          </Button>
        </motion.div>

        <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
          <div><span className="font-semibold text-foreground">{total}</span> usuários</div>
          <div><span className="font-semibold text-foreground">{stats.adminCount}</span> admins na página</div>
          <div><span className="font-semibold text-foreground">{stats.activeCount}</span> ativos na página</div>
        </div>

        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Buscar por nome ou email..."
            className="pl-9 h-9"
          />
        </div>

        {listQuery.isError ? (
          <EmptyState icon={<Users className="h-5 w-5" />} title="Erro ao carregar usuários" description={tableError} />
        ) : listQuery.isLoading ? (
          <EmptyState icon={<Users className="h-5 w-5" />} title="Carregando usuários" description="Aguarde enquanto buscamos os dados." />
        ) : users.length === 0 ? (
          <EmptyState
            icon={<Users className="h-5 w-5" />}
            title="Nenhum usuário encontrado"
            description={search ? "Tente ajustar sua busca." : "Crie o primeiro usuário da plataforma."}
          />
        ) : (
          <div className="glass-card overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead><button className="font-semibold" onClick={() => toggleSort("name")}>Nome</button></TableHead>
                  <TableHead><button className="font-semibold" onClick={() => toggleSort("email")}>Email</button></TableHead>
                  <TableHead><button className="font-semibold" onClick={() => toggleSort("role")}>Papel</button></TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead><button className="font-semibold" onClick={() => toggleSort("last_login_at")}>Último login</button></TableHead>
                  <TableHead><button className="font-semibold" onClick={() => toggleSort("updated_at")}>Atualizado em</button></TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.full_name || "-"}</TableCell>
                    <TableCell>{user.email}</TableCell>
                    <TableCell>{user.role}</TableCell>
                    <TableCell>{user.is_active ? "Ativo" : "Inativo"}</TableCell>
                    <TableCell>{formatDateTimeBR(user.last_login_at)}</TableCell>
                    <TableCell>{formatDateTimeBR(user.updated_at)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDetailUser(user)} aria-label="Ver usuário">
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditUser(user)} aria-label="Editar usuário">
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          onClick={() => setDeleteUser(user)}
                          aria-label="Excluir usuário"
                          disabled={currentUser?.id === user.id}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">Página {page} de {totalPages}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={!canPrev} onClick={() => setPage((prev) => Math.max(1, prev - 1))}>
              Anterior
            </Button>
            <Button variant="outline" size="sm" disabled={!canNext} onClick={() => setPage((prev) => prev + 1)}>
              Próxima
            </Button>
          </div>
        </div>
      </main>

      <UserCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        submitting={createMutation.isPending}
        onSubmit={(payload) => createMutation.mutate(payload)}
      />
      <UserDetailDialog user={detailUser} onOpenChange={(open) => !open && setDetailUser(null)} />
      <UserEditDialog
        user={editUser}
        submitting={updateMutation.isPending}
        onOpenChange={(open) => !open && setEditUser(null)}
        onSubmit={(id, payload) => updateMutation.mutate({ id, payload })}
      />
      <ConfirmDialog
        open={!!deleteUser}
        onOpenChange={() => setDeleteUser(null)}
        title="Excluir usuário?"
        description={`Esta ação desativará e ocultará "${deleteUser?.full_name || deleteUser?.email}".`}
        confirmLabel="Excluir"
        destructive
        onConfirm={() => deleteUser && deleteMutation.mutate(deleteUser.id)}
      />
    </div>
  );
};

const UserCreateDialog = ({
  open,
  onOpenChange,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submitting: boolean;
  onSubmit: (payload: { name: string; email: string; role: "ADMIN" | "USER"; is_active: boolean; password: string }) => void;
}) => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"ADMIN" | "USER">("USER");
  const [isActive, setIsActive] = useState(true);
  const [password, setPassword] = useState("");

  const handleSubmit = () => {
    if (!name.trim() || !email.trim() || password.length < 8) return;
    onSubmit({ name: name.trim(), email: email.trim(), role, is_active: isActive, password });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setName("");
          setEmail("");
          setRole("USER");
          setIsActive(true);
          setPassword("");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Novo usuário</DialogTitle>
          <DialogDescription>Preencha os dados para criar um novo login.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label>Nome</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Papel</Label>
            <Select value={role} onValueChange={(v) => setRole(v as "ADMIN" | "USER")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="USER">USER</SelectItem>
                <SelectItem value="ADMIN">ADMIN</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Senha (mínimo 8 caracteres)</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="create-active">Ativo</Label>
            <Switch id="create-active" checked={isActive} onCheckedChange={setIsActive} />
          </div>
          <Button className="w-full" disabled={submitting} onClick={handleSubmit}>
            {submitting ? "Criando..." : "Criar usuário"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const UserDetailDialog = ({
  user,
  onOpenChange,
}: {
  user: ApiAdminUser | null;
  onOpenChange: (open: boolean) => void;
}) => (
  <Dialog open={!!user} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Detalhes do usuário</DialogTitle>
        <DialogDescription>Informações do login selecionado.</DialogDescription>
      </DialogHeader>
      {user && (
        <div className="space-y-2 text-sm">
          <p><span className="font-semibold">Nome:</span> {user.full_name || "-"}</p>
          <p><span className="font-semibold">Email:</span> {user.email}</p>
          <p><span className="font-semibold">Papel:</span> {user.role}</p>
          <p><span className="font-semibold">Status:</span> {user.is_active ? "Ativo" : "Inativo"}</p>
          <p><span className="font-semibold">Criado em:</span> {formatDateTimeBR(user.created_at)}</p>
          <p><span className="font-semibold">Atualizado em:</span> {formatDateTimeBR(user.updated_at)}</p>
          <p><span className="font-semibold">Último login:</span> {formatDateTimeBR(user.last_login_at)}</p>
        </div>
      )}
    </DialogContent>
  </Dialog>
);

const UserEditDialog = ({
  user,
  submitting,
  onOpenChange,
  onSubmit,
}: {
  user: ApiAdminUser | null;
  submitting: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (id: number, payload: Partial<{ name: string; email: string; role: "ADMIN" | "USER"; is_active: boolean }>) => void;
}) => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"ADMIN" | "USER">("USER");
  const [isActive, setIsActive] = useState(true);

  const open = !!user;
  const currentId = user?.id;

  useEffect(() => {
    if (!user) return;
    setName(user.full_name || "");
    setEmail(user.email);
    setRole(user.role);
    setIsActive(user.is_active);
  }, [user]);

  const syncState = (nextOpen: boolean) => {
    if (!nextOpen) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={syncState}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar usuário</DialogTitle>
          <DialogDescription>Ajuste os dados e permissões do usuário.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label>Nome</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Papel</Label>
            <Select value={role} onValueChange={(v) => setRole(v as "ADMIN" | "USER")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="USER">USER</SelectItem>
                <SelectItem value="ADMIN">ADMIN</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="edit-active">Ativo</Label>
            <Switch id="edit-active" checked={isActive} onCheckedChange={setIsActive} />
          </div>
          <Button
            className="w-full"
            disabled={!currentId || submitting}
            onClick={() => currentId && onSubmit(currentId, { name, email, role, is_active: isActive })}
          >
            {submitting ? "Salvando..." : "Salvar alterações"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default AdminUsersPage;
