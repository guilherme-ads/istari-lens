import type { Datasource } from "@/types";

const INTERNAL_IMPORTED_NAME_PATTERN = /^Lens Internal Imported(?:\s*\(\d+\))?$/i;
const INTERNAL_IMPORTED_SCHEMA_PATTERN = /^lens_imp_t\d+$/i;

const normalizeSchemaPattern = (value: string): string => value.replace(/[%*]/g, "").trim();

export const isInternalWorkspaceDatasource = (datasource: Pick<Datasource, "name" | "schemaPattern" | "sourceType">): boolean => {
  if (datasource.sourceType !== "database") return false;
  const name = String(datasource.name || "").trim();
  const schemaPattern = normalizeSchemaPattern(String(datasource.schemaPattern || ""));
  return INTERNAL_IMPORTED_NAME_PATTERN.test(name) || INTERNAL_IMPORTED_SCHEMA_PATTERN.test(schemaPattern);
};

