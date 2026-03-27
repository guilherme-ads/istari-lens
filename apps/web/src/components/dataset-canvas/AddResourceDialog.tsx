import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, type ApiCatalogResource, type ApiCatalogResourceSchemaField } from "@/lib/api";
import type { Datasource } from "@/types";

type AddResourceDialogProps = {
  open: boolean;
  datasources: Datasource[];
  initialDatasourceId?: string | null;
  allowedDatasourceIds?: string[];
  onOpenChange: (open: boolean) => void;
  onSelect: (resource: ApiCatalogResource, fields: ApiCatalogResourceSchemaField[], datasourceId: string) => void;
};

const AddResourceDialog = ({
  open,
  datasources,
  initialDatasourceId = null,
  allowedDatasourceIds,
  onOpenChange,
  onSelect,
}: AddResourceDialogProps) => {
  const [search, setSearch] = useState("");
  const allowedSet = useMemo(() => new Set(allowedDatasourceIds || datasources.map((item) => item.id)), [allowedDatasourceIds, datasources]);
  const selectableDatasources = useMemo(
    () => datasources.filter((item) => allowedSet.has(item.id)),
    [allowedSet, datasources],
  );
  const [selectedDatasourceId, setSelectedDatasourceId] = useState<string>(initialDatasourceId || selectableDatasources[0]?.id || "");

  useEffect(() => {
    if (!open) return;
    if (selectedDatasourceId && selectableDatasources.some((item) => item.id === selectedDatasourceId)) return;
    if (initialDatasourceId && selectableDatasources.some((item) => item.id === initialDatasourceId)) {
      setSelectedDatasourceId(initialDatasourceId);
      return;
    }
    setSelectedDatasourceId(selectableDatasources[0]?.id || "");
  }, [initialDatasourceId, open, selectableDatasources, selectedDatasourceId]);

  const resourcesQuery = useQuery({
    queryKey: ["catalog-resources", selectedDatasourceId],
    enabled: open && !!selectedDatasourceId,
    queryFn: () => api.listCatalogResources(Number(selectedDatasourceId)),
  });

  const items = useMemo(() => {
    const all = resourcesQuery.data?.items || [];
    const term = search.trim().toLowerCase();
    if (!term) return all;
    return all.filter((item) => `${item.schema_name}.${item.resource_name}`.toLowerCase().includes(term));
  }, [resourcesQuery.data?.items, search]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Adicionar recurso</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Select value={selectedDatasourceId || "__none__"} onValueChange={(value) => setSelectedDatasourceId(value === "__none__" ? "" : value)}>
              <SelectTrigger>
                <SelectValue placeholder="Selecione um datasource" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Selecione...</SelectItem>
                {selectableDatasources.map((item) => (
                  <SelectItem key={`ds-${item.id}`} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectableDatasources.length === 0 ? (
              <p className="text-sm text-warning">Nenhum datasource permitido para o modo atual.</p>
            ) : null}
          </div>
          <Input
            placeholder="Buscar recurso..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            disabled={!selectedDatasourceId}
          />
          <ScrollArea className="h-72 rounded-md border border-border">
            <div className="space-y-1 p-2">
              {items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className="w-full rounded-md border border-transparent px-3 py-2 text-left hover:border-border hover:bg-muted/40"
                  onClick={async () => {
                    if (!selectedDatasourceId) return;
                    try {
                      const schema = await api.getCatalogResourceSchema(item.id, Number(selectedDatasourceId));
                      onSelect(item, schema.fields || [], selectedDatasourceId);
                      onOpenChange(false);
                    } catch (error) {
                      // Keep the dialog open if schema loading fails so the user can retry.
                      void error;
                    }
                  }}
                >
                  <p className="text-sm font-medium">{item.schema_name}.{item.resource_name}</p>
                  <p className="text-caption text-muted-foreground">{item.resource_type}</p>
                </button>
              ))}
              {!selectedDatasourceId ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">Selecione um datasource para listar recursos.</p>
              ) : null}
              {selectedDatasourceId && items.length === 0 && !resourcesQuery.isLoading ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">Nenhum recurso encontrado.</p>
              ) : null}
            </div>
          </ScrollArea>
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Fechar
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default AddResourceDialog;
