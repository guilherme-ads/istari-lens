import { cn } from "@/lib/utils";

interface BrandLogoProps {
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeClasses = {
  sm: "text-xs",
  md: "text-base",
  lg: "text-lg",
};

const BrandLogo = ({ size = "md", className }: BrandLogoProps) => (
  <span className={cn("whitespace-nowrap leading-none", sizeClasses[size], className)}>
    {/* Cliente pediu remover "istari" da marca visivel; para reverter, restaurar "istari Lens". */}
    <span className="font-extrabold tracking-tight">Lens</span>
  </span>
);

export default BrandLogo;
