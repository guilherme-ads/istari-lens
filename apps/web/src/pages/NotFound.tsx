import { useLocation, Link } from "react-router-dom";
import { useEffect } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Search } from "lucide-react";
import BrandLogo from "@/components/shared/BrandLogo";
import { Button } from "@/components/ui/button";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      {/* Decorative bg */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 h-[400px] w-[400px] rounded-full bg-accent/5 blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative z-10 flex flex-col items-center text-center max-w-md"
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent mb-6">
          <Search className="h-7 w-7" />
        </div>

        <h1 className="text-7xl font-extrabold tracking-tighter text-foreground">404</h1>
        <p className="mt-3 text-lg font-medium text-foreground">Página não encontrada</p>
        <p className="mt-2 text-sm text-muted-foreground max-w-xs">
          A página <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{location.pathname}</code> não existe ou foi movida.
        </p>

        <div className="flex gap-3 mt-8">
          <Button asChild className="bg-accent text-accent-foreground hover:bg-accent/90">
            <Link to="/datasets">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Ir para Datasets
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/login">Login</Link>
          </Button>
        </div>

        <div className="mt-12">
          <BrandLogo size="sm" className="text-muted-foreground" />
        </div>
      </motion.div>
    </div>
  );
};

export default NotFound;
