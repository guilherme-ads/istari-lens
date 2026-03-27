import type { ApiDatasetBaseQuerySpec } from "@/lib/api";
import type { DatasetCanvasEdge, DatasetCanvasNode } from "./canvas-types";

type CanvasSpecInput = {
  datasourceId: number;
  resources: Array<{ id: string; resourceId: string; isPrimary?: boolean }>;
  joins: Array<{
    type: "inner" | "left" | "right";
    leftResource: string;
    rightResource: string;
    conditions: Array<{ leftColumn: string; rightColumn: string }>;
    cardinality?: {
      estimated?: {
        value?: "1-1" | "1-N" | "N-1" | "N-N" | "indefinida";
        method?: string;
        sample_rows?: number;
        sampled_at?: string;
      };
      actual?: {
        value?: "1-1" | "1-N" | "N-1" | "N-N" | "indefinida";
        method?: string;
        computed_at?: string;
      };
    };
  }>;
  include: Array<{
    resource: string;
    column: string;
    alias: string;
    field_id?: string;
    semantic_type?: "text" | "numeric" | "temporal" | "boolean";
    sql_type?: string;
    prefix?: string;
    suffix?: string;
    aggregation?: "none" | "count" | "sum" | "avg" | "min" | "max" | "distinct_count";
    description?: string;
    hidden?: boolean;
    order?: number;
  }>;
  computedColumns: ApiDatasetBaseQuerySpec["preprocess"]["computed_columns"];
  filters: ApiDatasetBaseQuerySpec["preprocess"]["filters"];
};

export const mapCanvasToBaseQuerySpec = (input: CanvasSpecInput): ApiDatasetBaseQuerySpec => {
  const primary = input.resources.find((item) => item.isPrimary) ?? input.resources[0];
  return {
    version: 1,
    source: { datasource_id: input.datasourceId },
    base: {
      primary_resource: primary?.resourceId || "",
      resources: input.resources.map((item) => ({ id: item.id, resource_id: item.resourceId })),
      joins: input.joins.map((join) => {
        if (join.type !== "right") {
          return {
            type: join.type,
            left_resource: join.leftResource,
            right_resource: join.rightResource,
            cardinality: join.cardinality,
            on: join.conditions.map((condition) => ({
              left_column: condition.leftColumn,
              right_column: condition.rightColumn,
            })),
          };
        }
        // RIGHT JOIN semantica e equivalente a LEFT JOIN com lados invertidos.
        return {
          type: "left" as const,
          left_resource: join.rightResource,
          right_resource: join.leftResource,
          cardinality: join.cardinality,
          on: join.conditions.map((condition) => ({
            left_column: condition.rightColumn,
            right_column: condition.leftColumn,
          })),
        };
      }),
    },
    preprocess: {
      columns: {
        include: input.include,
        exclude: [],
      },
      computed_columns: input.computedColumns,
      filters: input.filters,
    },
  };
};

export const defaultCanvasLayout = (nodes: DatasetCanvasNode[]): DatasetCanvasNode[] => {
  return nodes.map((node, index) => {
    if (node.position.x !== 0 || node.position.y !== 0) return node;
    return {
      ...node,
      position: {
        x: 48 + index * 360,
        y: 72,
      },
    };
  });
};

export const isJoinEdgeInvalid = (edge: DatasetCanvasEdge | null | undefined): boolean => {
  if (!edge) return false;
  if (!["inner", "left", "right"].includes(edge.data.joinType)) return true;
  if (!edge.data.conditions.length) return true;
  return edge.data.conditions.some((item) => !item.leftColumn || !item.rightColumn);
};
