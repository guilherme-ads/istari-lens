import ContextualBreadcrumb from "@/components/shared/ContextualBreadcrumb";
import SkeletonCard from "@/components/shared/SkeletonCard";
import SkeletonTable from "@/components/shared/SkeletonTable";
import { Skeleton } from "@/components/ui/skeleton";

type SkeletonPageProps = {
  type?: "cards" | "table";
  cardVariant?: "dashboard" | "dataset" | "widget";
  cardsCount?: number;
  tableRows?: number;
  tableColumns?: number;
};

const SkeletonPage = ({
  type = "cards",
  cardVariant = "dashboard",
  cardsCount = 6,
  tableRows = 5,
  tableColumns = 4,
}: SkeletonPageProps) => {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <ContextualBreadcrumb items={[{ label: "Carregando..." }]} />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>

      {type === "table" ? (
        <SkeletonTable rows={tableRows} columns={tableColumns} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: cardsCount }).map((_, index) => (
            <SkeletonCard key={`card-${index}`} variant={cardVariant} />
          ))}
        </div>
      )}
    </div>
  );
};

export default SkeletonPage;

