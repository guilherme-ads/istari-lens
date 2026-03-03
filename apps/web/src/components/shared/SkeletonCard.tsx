import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type SkeletonCardVariant = "dashboard" | "dataset" | "widget";

type SkeletonCardProps = {
  variant?: SkeletonCardVariant;
  className?: string;
};

const variantMinHeight: Record<SkeletonCardVariant, string> = {
  dashboard: "min-h-[160px]",
  dataset: "min-h-[220px]",
  widget: "min-h-[180px]",
};

const SkeletonCard = ({ variant = "dashboard", className }: SkeletonCardProps) => {
  return (
    <div className={cn("glass-card p-5 flex flex-col gap-4 skeleton-shimmer", variantMinHeight[variant], className)}>
      <div className="flex items-start justify-between">
        <Skeleton className="h-9 w-9 rounded-lg" />
        <Skeleton className="h-6 w-14 rounded-md" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-5/6" />
        {(variant === "dataset" || variant === "widget") && <Skeleton className="h-3 w-1/2" />}
      </div>
      {variant === "dataset" && (
        <div className="flex flex-wrap gap-1.5">
          <Skeleton className="h-5 w-16 rounded-md" />
          <Skeleton className="h-5 w-12 rounded-md" />
          <Skeleton className="h-5 w-14 rounded-md" />
        </div>
      )}
      <div className="mt-auto flex items-center justify-between border-t border-border pt-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-14" />
      </div>
    </div>
  );
};

export default SkeletonCard;

