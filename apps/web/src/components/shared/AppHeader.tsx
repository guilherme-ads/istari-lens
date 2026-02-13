import { Link, useNavigate, useLocation } from "react-router-dom";
import { LogOut, BarChart3, Menu, X, Settings, Users } from "lucide-react";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getStoredUser } from "@/lib/auth";

interface AppHeaderProps {
  title?: string;
  showNav?: boolean;
  onLogout?: () => void;
}

// Cliente pediu remover "istari" do que e visivel; para reverter, voltar para "Istari Lens".
const AppHeader = ({ title = "Lens App", showNav = true, onLogout }: AppHeaderProps) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const user = getStoredUser();

  const navLinks = [
    { to: "/datasets", label: "Datasets", icon: BarChart3 },
    ...(user?.is_admin
      ? [
        { to: "/admin", label: "Fontes", icon: Settings },
        { to: "/admin/users", label: "Usuarios", icon: Users },
      ]
      : []),
  ];

  const handleLogout = () => {
    onLogout?.();
    navigate("/login");
  };

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-card/80 backdrop-blur-md">
      <div className="container flex h-14 items-center justify-between">
        <div className="flex items-center gap-6">
          <Link to="/datasets" className="flex items-center gap-2.5 group">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent shadow-sm group-hover:shadow-md transition-shadow">
              <BarChart3 className="h-4 w-4 text-accent-foreground" />
            </div>
            <span className="text-lg font-bold tracking-tight text-foreground">{title}</span>
          </Link>

          {showNav && (
            <nav className="hidden items-center gap-0.5 md:flex">
              {navLinks.map((link) => {
                const isActive = location.pathname.startsWith(link.to);
                return (
                  <Tooltip key={link.to}>
                    <TooltipTrigger asChild>
                      <Link
                        to={link.to}
                        className={`relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                          isActive
                            ? "text-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        <link.icon className="h-3.5 w-3.5" />
                        {link.label}
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
          )}
        </div>

        <div className="flex items-center gap-1">
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
                const isActive = location.pathname.startsWith(link.to);
                return (
                  <Link
                    key={link.to}
                    to={link.to}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                    }`}
                  >
                    <link.icon className="h-4 w-4" />
                    {link.label}
                  </Link>
                );
              })}
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
  );
};

export default AppHeader;
