import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ThemeToggleProps = {
  className?: string;
  showLabel?: boolean;
};

const ThemeToggle = ({ className, showLabel = false }: ThemeToggleProps) => {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = useMemo(() => resolvedTheme === "dark", [resolvedTheme]);
  const nextTheme = isDark ? "light" : "dark";

  return (
    <Button
      type="button"
      variant="ghost"
      size={showLabel ? "sm" : "icon"}
      className={cn(showLabel ? "justify-start gap-2 px-3" : "", className)}
      onClick={() => setTheme(nextTheme)}
      aria-label={mounted ? `Alternar para tema ${nextTheme === "dark" ? "escuro" : "claro"}` : "Alternar tema"}
      title={mounted ? `Alternar para tema ${nextTheme === "dark" ? "escuro" : "claro"}` : "Alternar tema"}
    >
      <span className="relative inline-flex h-4 w-4 items-center justify-center">
        <Sun
          className={cn(
            "absolute h-4 w-4 text-muted-foreground transition-all duration-300",
            isDark ? "rotate-90 scale-0 opacity-0" : "rotate-0 scale-100 opacity-100",
          )}
        />
        <Moon
          className={cn(
            "absolute h-4 w-4 text-muted-foreground transition-all duration-300",
            isDark ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-0 opacity-0",
          )}
        />
      </span>
      {showLabel && <span className="text-sm font-medium">{isDark ? "Tema escuro" : "Tema claro"}</span>}
    </Button>
  );
};

export default ThemeToggle;
