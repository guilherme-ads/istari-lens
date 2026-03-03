import { Outlet, Link, useNavigate, useLocation } from "react-router-dom";
import { useState } from "react";
import { LogOut, Settings, Layers, Home, Menu, X, BarChart3, LayoutDashboard, Users, KeyRound, UserCog } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import BrandLogo from "@/components/shared/BrandLogo";
import ThemeToggle from "@/components/shared/ThemeToggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getStoredUser } from "@/lib/auth";
import { api } from "@/lib/api";

const AppLayout = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const user = getStoredUser();

  const navLinks = [
    { to: "/home", label: "Home", icon: Home },
    { to: "/datasets", label: "Datasets", icon: Layers },
    { to: "/dashboards", label: "Dashboards", icon: LayoutDashboard },
    ...(user?.is_admin
      ? [
        { to: "/admin", label: "Fontes", icon: Settings },
      ]
      : []),
  ];

  const handleLogout = async () => {
    await api.logout();
    navigate("/login");
  };

  const isActiveLink = (to: string) => {
    if (to === "/admin") return location.pathname === "/admin";
    if (to === "/api-config") return location.pathname === "/api-config";
    return location.pathname === to || (to !== "/home" && location.pathname.startsWith(`${to}/`));
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 border-b border-border bg-card/80 backdrop-blur-md">
        <div className="container flex h-14 items-center justify-between">
          <div className="flex items-center gap-6">
            <Link to="/home" className="flex items-center gap-2.5 group">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent shadow-sm group-hover:shadow-md transition-shadow">
                <BarChart3 className="h-4 w-4 text-accent-foreground" />
              </div>
              <BrandLogo className="text-foreground" />
            </Link>

            <nav className="hidden items-center gap-0.5 md:flex">
              {navLinks.map((link) => {
                const isActive = isActiveLink(link.to);
                return (
                  <Tooltip key={link.to}>
                    <TooltipTrigger asChild>
                      <Link
                        to={link.to}
                        className={`group relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-all duration-200 ease-out ${
                          isActive ? "bg-accent/10 text-foreground border-l-2 border-accent" : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
                        }`}
                      >
                        <link.icon className="h-3.5 w-3.5" />
                        <span className="transition-transform duration-200 ease-out group-hover:translate-x-[2px]">{link.label}</span>
                        {isActive && (
                          <motion.div
                            layoutId="nav-indicator"
                            className="absolute -bottom-[17px] left-2 right-2 h-0.5 rounded-full bg-accent"
                            transition={{ type: "spring", stiffness: 500, damping: 35 }}
                          />
                        )}
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent className="text-xs">{link.label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-1">
            {user?.is_admin && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link
                      to="/admin/users"
                      className={`hidden items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors md:flex ${
                        isActiveLink("/admin/users")
                          ? "text-foreground"
                          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                      }`}
                    >
                      <Users className="h-3.5 w-3.5" />
                      Usuários
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">Usuários</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link
                      to="/api-config"
                      className={`hidden items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors md:flex ${
                        isActiveLink("/api-config")
                          ? "text-foreground"
                          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                      }`}
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      APIs
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">APIs</TooltipContent>
                </Tooltip>
              </>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  to="/account"
                  className={`hidden items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors md:flex ${
                    isActiveLink("/account")
                      ? "text-foreground"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                  }`}
                >
                  <UserCog className="h-3.5 w-3.5" />
                  Conta
                </Link>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Minha conta</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <ThemeToggle className="hidden md:inline-flex" />
              </TooltipTrigger>
              <TooltipContent className="text-xs">Alternar tema</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleLogout}
                  className="hidden items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground md:flex"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Sair
                </button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Encerrar sessão</TooltipContent>
            </Tooltip>
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="rounded-md p-2 text-muted-foreground hover:bg-secondary md:hidden"
              aria-label="Menu"
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden border-t border-border md:hidden"
            >
              <nav className="container flex flex-col gap-1 py-3">
                {navLinks.map((link) => {
                  const isActive = isActiveLink(link.to);
                  return (
                    <Link
                      key={link.to}
                      to={link.to}
                      onClick={() => setMobileMenuOpen(false)}
                      className={`group flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${
                        isActive ? "bg-accent/10 text-foreground border-l-2 border-accent" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                      }`}
                    >
                      <link.icon className="h-4 w-4" />
                      <span className="transition-transform duration-200 ease-out group-hover:translate-x-[2px]">{link.label}</span>
                    </Link>
                  );
                })}
                {user?.is_admin && (
                  <>
                    <Link
                      to="/admin/users"
                      onClick={() => setMobileMenuOpen(false)}
                      className={`flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${
                        isActiveLink("/admin/users")
                          ? "bg-accent/10 text-foreground border-l-2 border-accent"
                          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                      }`}
                    >
                      <Users className="h-4 w-4" />
                      Usuários
                    </Link>
                    <Link
                      to="/api-config"
                      onClick={() => setMobileMenuOpen(false)}
                      className={`flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${
                        isActiveLink("/api-config")
                          ? "bg-accent/10 text-foreground border-l-2 border-accent"
                          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                      }`}
                    >
                      <KeyRound className="h-4 w-4" />
                      APIs
                    </Link>
                  </>
                )}
                <Link
                  to="/account"
                  onClick={() => setMobileMenuOpen(false)}
                  className={`flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${
                    isActiveLink("/account")
                      ? "bg-accent/10 text-foreground border-l-2 border-accent"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                  }`}
                >
                  <UserCog className="h-4 w-4" />
                  Conta
                </Link>
                <ThemeToggle showLabel className="w-full justify-start text-muted-foreground hover:bg-secondary hover:text-foreground" />
                <div className="my-1 h-px bg-border" />
                <button
                  onClick={handleLogout}
                  className="flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  <LogOut className="h-4 w-4" />
                  Sair
                </button>
              </nav>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
};

export default AppLayout;

