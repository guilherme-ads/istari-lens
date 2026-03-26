export type DatasetFieldAggregation = "none" | "count" | "sum" | "avg" | "min" | "max" | "distinct_count";
export type DatasetFieldSemanticType = "text" | "numeric" | "temporal" | "boolean";

export type DatasetCanvasNode = {
  id: string;
  type: "resource";
  position: { x: number; y: number };
  data: {
    resourceId: string;
    label: string;
    fields: Array<{
      id: string;
      name: string;
      type: string;
      selected: boolean;
      alias?: string;
      semanticType?: DatasetFieldSemanticType;
      prefix?: string;
      suffix?: string;
      aggregation?: DatasetFieldAggregation;
      description?: string;
    }>;
    isPrimary?: boolean;
  };
};

export type DatasetCanvasEdge = {
  id: string;
  source: string;
  target: string;
  type: "join";
  data: {
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
    joinType: "inner" | "left" | "right";
    conditions: Array<{
      leftColumn: string;
      rightColumn: string;
    }>;
  };
};
