import { Skeleton } from "@/components/ui/skeleton";

type SkeletonTableProps = {
  rows?: number;
  columns?: number;
  className?: string;
};

const SkeletonTable = ({ rows = 5, columns = 4, className }: SkeletonTableProps) => {
  return (
    <div className={`rounded-lg border border-border overflow-hidden skeleton-shimmer ${className || ""}`}>
      <div className="grid gap-3 border-b border-border bg-muted/40 px-4 py-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {Array.from({ length: columns }).map((_, index) => (
          <Skeleton key={`header-${index}`} className="h-3 w-3/4" />
        ))}
      </div>
      <div className="space-y-2 px-4 py-3">
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div
            key={`row-${rowIndex}`}
            className="grid gap-3 py-2"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: columns }).map((_, colIndex) => (
              <Skeleton key={`cell-${rowIndex}-${colIndex}`} className="h-3.5 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

export default SkeletonTable;

