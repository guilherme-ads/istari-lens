import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import EmptyState from "./EmptyState";
import { Database } from "lucide-react";
import { ReactNode } from "react";
import SkeletonTable from "@/components/shared/SkeletonTable";

export interface DataTableColumn<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  className?: string;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  data: T[];
  loading?: boolean;
  loadingRows?: number;
  loadingColumns?: number;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
}

function DataTable<T extends Record<string, any>>({
  columns,
  data,
  loading = false,
  loadingRows = 5,
  loadingColumns,
  emptyTitle = "Nenhum dado encontrado",
  emptyDescription = "Nao ha registros para exibir.",
  emptyAction,
}: DataTableProps<T>) {
  if (loading) {
    return <SkeletonTable rows={loadingRows} columns={loadingColumns || Math.max(columns.length, 1)} />;
  }

  if (data.length === 0) {
    return (
      <EmptyState
        icon={<Database className="h-5 w-5" />}
        title={emptyTitle}
        description={emptyDescription}
        action={emptyAction}
      />
    );
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            {columns.map((col) => (
              <TableHead key={col.key} className={col.className}>
                {col.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row, i) => (
            <TableRow key={i}>
              {columns.map((col) => (
                <TableCell key={col.key} className={col.className}>
                  {col.render ? col.render(row) : row[col.key]}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default DataTable;
