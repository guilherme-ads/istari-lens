import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { mapDashboard, mapDataset, mapDatasource, mapView } from "@/lib/mappers";
import { getAuthToken } from "@/lib/auth";

export const useCoreData = () => {
  const hasToken = !!getAuthToken();
  const datasourcesQuery = useQuery({
    queryKey: ["datasources"],
    queryFn: api.listDatasources,
    enabled: hasToken,
  });

  const viewsQuery = useQuery({
    queryKey: ["views"],
    queryFn: async () => {
      try {
        return await api.listViews();
      } catch {
        return [];
      }
    },
    enabled: hasToken,
  });

  const datasetsQuery = useQuery({
    queryKey: ["datasets"],
    queryFn: api.listDatasets,
    enabled: hasToken,
  });

  const dashboardsQuery = useQuery({
    queryKey: ["dashboards"],
    queryFn: () => api.listDashboards(),
    enabled: hasToken,
  });

  const datasources = useMemo(
    () => (datasourcesQuery.data || []).map(mapDatasource),
    [datasourcesQuery.data],
  );

  const views = useMemo(() => {
    const adminViews = (viewsQuery.data || []).map(mapView);
    if (adminViews.length > 0) return adminViews;

    const inferred = new Map<string, ReturnType<typeof mapView>>();
    (datasetsQuery.data || []).forEach((dataset) => {
      const mapped = mapView(dataset.view);
      inferred.set(mapped.id, mapped);
    });
    return Array.from(inferred.values());
  }, [viewsQuery.data, datasetsQuery.data]);

  const datasets = useMemo(() => {
    const dashboards = dashboardsQuery.data || [];
    const grouped = new Map<string, string[]>();

    dashboards.forEach((dashboard) => {
      const datasetId = String(dashboard.dataset_id);
      const ids = grouped.get(datasetId) || [];
      ids.push(String(dashboard.id));
      grouped.set(datasetId, ids);
    });

    return (datasetsQuery.data || []).map((dataset) => mapDataset(dataset, grouped.get(String(dataset.id)) || []));
  }, [datasetsQuery.data, dashboardsQuery.data]);

  const datasetsById = useMemo(() => {
    const map = new Map<string, (typeof datasets)[number]>();
    datasets.forEach((dataset) => map.set(dataset.id, dataset));
    return map;
  }, [datasets]);

  const dashboards = useMemo(
    () => (dashboardsQuery.data || []).map((dashboard) => mapDashboard(dashboard)),
    [dashboardsQuery.data],
  );

  const isLoading =
    hasToken &&
    (datasourcesQuery.isLoading || viewsQuery.isLoading || datasetsQuery.isLoading || dashboardsQuery.isLoading);

  const isError = hasToken && (datasourcesQuery.isError || datasetsQuery.isError || dashboardsQuery.isError);

  const errorMessage =
    (datasourcesQuery.error as Error | undefined)?.message ||
    (datasetsQuery.error as Error | undefined)?.message ||
    (dashboardsQuery.error as Error | undefined)?.message ||
    "Erro ao carregar dados";

  return {
    datasources,
    views,
    datasets,
    dashboards,
    datasetsById,
    hasToken,
    isLoading,
    isError,
    errorMessage,
    refetchAll: () => {
      datasourcesQuery.refetch();
      viewsQuery.refetch();
      datasetsQuery.refetch();
      dashboardsQuery.refetch();
    },
  };
};
