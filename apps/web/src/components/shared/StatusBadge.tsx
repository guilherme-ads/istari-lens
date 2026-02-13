import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const statusBadgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors",
  {
    variants: {
      status: {
        active: "bg-success/10 text-success",
        inactive: "bg-destructive/10 text-destructive",
        syncing: "bg-warning/10 text-warning",
      },
    },
    defaultVariants: {
      status: "active",
    },
  }
);

interface StatusBadgeProps extends VariantProps<typeof statusBadgeVariants> {
  label?: string;
  className?: string;
}

const StatusBadge = ({ status, label, className }: StatusBadgeProps) => {
  const defaultLabels = {
    active: "Active",
    inactive: "Inactive",
    syncing: "Syncing…",
  };

  return (
    <span className={cn(statusBadgeVariants({ status }), className)}>
      <span className={cn(
        "h-1.5 w-1.5 rounded-full",
        status === "active" && "bg-success",
        status === "inactive" && "bg-destructive",
        status === "syncing" && "bg-warning animate-pulse",
      )} />
      {label || defaultLabels[status || "active"]}
    </span>
  );
};

export default StatusBadge;
