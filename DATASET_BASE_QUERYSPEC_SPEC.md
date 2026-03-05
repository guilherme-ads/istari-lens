# Dataset Base QuerySpec Specification (Block A)

## Status
- Date: 2026-03-04
- Scope: Contract definition only (no runtime implementation in this block)
- Owners: API + Engine + Web

## Goals
- Define a `dataset.base_query_spec` contract that allows one or more tables/views from the same datasource.
- Define configurable dataset-level preprocessing:
  - column projection (include/exclude)
  - column rename (alias)
- Define dataset-level calculated columns.
- Define deterministic merge rules between:
  - dataset base query spec (mother spec)
  - dashboard/widget query specs
- Define legacy compatibility strategy from `datasets.view_id`.

## Non-goals
- No SQL free-text authoring by end users.
- No cross-datasource joins.
- No execution/runtime optimizations (materialization/cache) in this block.

## Terminology
- `dataset.base_query_spec`: canonical logical model of a dataset.
- `semantic columns`: final columns exposed by dataset after preprocessing and computed columns.
- `widget spec`: current dashboard widget query config converted to engine shape.
- `final spec`: output of composition (`dataset.base_query_spec` + widget spec) sent to engine.

## Canonical Contract

### Root shape
```json
{
  "version": 1,
  "source": {
    "datasource_id": 12
  },
  "base": {
    "primary_resource": "public.orders",
    "resources": [
      {
        "id": "orders",
        "resource_id": "public.orders"
      },
      {
        "id": "customers",
        "resource_id": "public.customers"
      }
    ],
    "joins": [
      {
        "type": "left",
        "left_resource": "orders",
        "right_resource": "customers",
        "on": [
          {
            "left_column": "customer_id",
            "right_column": "id"
          }
        ]
      }
    ]
  },
  "preprocess": {
    "columns": {
      "include": [
        { "resource": "orders", "column": "id", "alias": "order_id" },
        { "resource": "orders", "column": "created_at", "alias": "order_date" },
        { "resource": "customers", "column": "name", "alias": "customer_name" },
        { "resource": "orders", "column": "total_amount", "alias": "gross_amount" },
        { "resource": "orders", "column": "discount_amount", "alias": "discount_amount" }
      ],
      "exclude": []
    },
    "computed_columns": [
      {
        "alias": "net_amount",
        "expr": {
          "op": "sub",
          "args": [
            { "column": "gross_amount" },
            { "column": "discount_amount" }
          ]
        },
        "data_type": "numeric"
      }
    ],
    "filters": []
  }
}
```

### Field definitions
- `version`: contract version, starts at `1`.
- `source.datasource_id`: datasource owner of all resources.
- `base.primary_resource`: root relation used as base alias.
- `base.resources[]`:
  - `id`: local alias/key for references.
  - `resource_id`: `schema.table_or_view`.
- `base.joins[]`:
  - `type`: `inner | left`.
  - `left_resource`, `right_resource`: must exist in `resources`.
  - `on[]`: join keys (`left_column`, `right_column`).
- `preprocess.columns.include[]`:
  - explicit projection list for semantic columns.
  - `alias` is required and unique in dataset output.
- `preprocess.columns.exclude[]`:
  - optional explicit deny-list after include expansion (kept for compatibility/future).
- `preprocess.computed_columns[]`:
  - `alias` unique and cannot collide with projected aliases.
  - `expr` is expression AST (safe subset only; no SQL string).
  - `data_type`: normalized type (`numeric | temporal | text | boolean`).
- `preprocess.filters[]`:
  - optional fixed dataset-level filters to apply in all queries.

## Expression AST for computed columns

### Allowed node types
- `{ "column": "<semantic_column_name>" }`
- `{ "literal": <string|number|boolean|null> }`
- `{ "op": "add|sub|mul|div|concat|coalesce|lower|upper|date_trunc", "args": [ ... ] }`

### Rules
- No raw SQL string allowed.
- `div` must compile with divide-by-zero safety (`NULLIF` policy).
- All referenced columns must exist in semantic namespace at compile-time.
- Function arity and type compatibility are validated.

## Merge Rules (Dataset + Widget)

### Principle
- Dataset defines the stable semantic layer.
- Widget defines analytical intent over semantic columns.
- Widget cannot escape dataset boundaries.

### Composition algorithm (deterministic)
1. Validate dataset is active and has valid `base_query_spec`.
2. Build semantic relation from dataset base:
   - resources + joins
   - preprocess projection
   - computed columns
   - dataset-level fixed filters
3. Validate widget spec references only semantic columns.
4. Build final analytical query over semantic relation:
   - widget metrics/dimensions/time/order/limit
   - runtime filters (dashboard native + widget + global)
5. Send final composed spec to engine.

### Precedence rules
- `resource_id`:
  - source of truth is dataset base relation.
  - widget-provided `view_name/resource_id` is ignored or rejected (strict mode preferred).
- Filters:
  - final filters = `dataset_fixed_filters AND dashboard_native_filters AND widget_filters AND runtime_global_filters`.
- Limit/offset/top_n:
  - controlled by widget (same current behavior), bounded by global engine limits.
- Columns available to widget:
  - only dataset semantic columns (projected + computed).

### Validation failures (must raise 400)
- Widget references unknown semantic column.
- Computed column alias collision.
- Join references unknown resources/columns.
- Cross-datasource reference.
- Disallowed expression node/operator.

## Legacy Compatibility Strategy (`view_id`)

### Phase 1 (dual-read/write)
- Keep existing `datasets.view_id`.
- Introduce nullable `datasets.base_query_spec`.
- For legacy dataset without `base_query_spec`, build implicit spec:
```json
{
  "version": 1,
  "source": { "datasource_id": "<dataset.datasource_id>" },
  "base": {
    "primary_resource": "<view.schema_name>.<view.view_name>",
    "resources": [
      { "id": "base", "resource_id": "<view.schema_name>.<view.view_name>" }
    ],
    "joins": []
  },
  "preprocess": { "columns": { "include": [], "exclude": [] }, "computed_columns": [], "filters": [] }
}
```
- Empty `include` means "all columns from base resource" in legacy compatibility mode.

### Phase 2 (backfill)
- Migration script generates `base_query_spec` for all existing datasets.
- API starts returning normalized `base_query_spec` for every dataset.

### Phase 3 (enforcement)
- New widgets stop requiring hard binding to dataset `view_name`.
- Validation migrates from `dataset.view.columns` to dataset semantic columns.

### Phase 4 (cleanup)
- Remove runtime dependency on `view_id` in query execution path.
- Optional schema cleanup in later migration.

## Security/Compliance Constraints
- Always compile SQL from validated AST/config, never from user SQL text.
- Identifiers must be validated against synced metadata.
- Values remain parameterized.
- Keep same datasource and workspace authorization checks currently in API/engine access modules.

## Open Decisions (explicitly deferred)
- Whether to support `union_all` in `base` for v1 (recommended: defer to v1.1).
- Whether semantic columns are persisted as JSON (`semantic_columns`) or normalized table (`dataset_columns`) (recommended: normalized table).
- Whether strict mode rejects widget `view_name` immediately or soft-ignores during transition.

## Deliverables of Block A
- This specification file.
- Agreement that all downstream tasks (Blocks B-G) follow this contract and merge behavior.
