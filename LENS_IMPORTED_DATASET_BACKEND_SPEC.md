# Lens Backend Spec: Imported Dataset Execution Mode

## Status
- Date: 2026-03-20
- Scope: Backend contract and rollout plan
- Owners: API + Engine + Data Platform

## 1. Objective
Add an explicit `imported` execution mode for datasets.

- `direct`:
  queries run against the customer datasource.
- `imported`:
  Lens materializes the dataset into Lens-managed internal Postgres, and queries run there.

The key constraint is product compatibility:

- the dataset logical contract must stay stable
- imported mode must not fork the dataset semantic model
- existing dashboards, builder flows, catalog, and query preview must keep working
- switching from `direct` to `imported` must be low-friction for already-created datasets
- cutover to imported execution should happen automatically only when imported storage is ready
- imported physical assets for one workspace should converge into one internal schema

## 2. Product Reality

The current product already has a dataset contract:

- `datasets.datasource_id` is the logical origin datasource
- `datasets.base_query_spec` is the dataset logical definition
- `datasets.semantic_columns` is the user-facing semantic schema
- catalog, query preview, widgets, and dashboard execution all depend on those fields

Because of that, imported mode must be modeled as an execution strategy, not as a second dataset definition model.

### Non-goal for v1
Do not introduce a second source-definition DSL for imports.

That means v1 does not duplicate:

- selected columns
- row filters
- joins
- computed columns

inside `dataset_import_configs`.

Those stay in `dataset.base_query_spec`, which is already the canonical logical model.

## 3. Guiding Decisions

1. Imported mode is explicit and opt-in.
2. `base_query_spec` remains the canonical logical contract for the dataset.
3. `datasource_id` remains the logical origin and authorization anchor.
4. Imported mode adds an execution binding layer, not a second semantic layer.
5. The worker materializes the dataset logical relation into internal storage.
6. Query execution resolves effective datasource and effective resource at runtime.
7. v1 is intentionally narrow: simple, reliable full refresh first.
8. Persisted `access_mode` is the desired mode; runtime computes the effective mode.
9. `direct -> imported` cutover is automatic only after the first successful publish.
10. Existing datasets can be bulk-enrolled into imported mode at datasource scope.
11. Imported execution uses a workspace-level internal schema as convergence layer.
12. Spreadsheet imports and datasource-based imports must land in the same workspace internal schema for imported-mode joins.
13. `copy_policy=forbidden` enforces direct-only execution for datasets anchored on that datasource.

## 4. Scope

### In scope
- dataset execution mode selection: `direct | imported`
- internal materialization of a dataset into Lens-managed Postgres
- manual sync and scheduled sync
- run history and run status
- dataset execution binding resolution
- internal metadata registration in `views` and `view_columns`
- schema drift detection for fields referenced by the dataset logical contract
- observability, retries, and operational controls
- imported-mode joins between DB-origin resources and spreadsheet-origin resources inside the same workspace convergence layer

### Out of scope
- frontend UX redesign
- CDC / logical replication
- free-text source SQL in v1
- direct-mode cross-source joins
- imported-mode-specific semantic modeling separate from `base_query_spec`
- delete reconciliation and merge/upsert semantics in v1

## 5. Proposed Model

## 5.1 Logical Dataset
The logical dataset remains what the product already understands:

- `datasets.datasource_id`
- `datasets.view_id` for legacy datasets
- `datasets.base_query_spec`
- `datasets.semantic_columns`

These fields describe what the dataset means.

They do not change when the dataset switches from `direct` to `imported`.

## 5.2 Execution Binding
Imported mode introduces a separate execution binding:

- which datasource should actually be queried
- which internal published resource should actually be queried
- when that internal published resource was last refreshed
- what run produced the currently published version

This binding is operational, not semantic.

## 5.3 Desired Mode vs Effective Mode
`datasets.access_mode` is the desired execution mode selected by product/API.

Runtime derives an `effective_access_mode`:

- effective `direct` when:
  - `access_mode=direct`, or
  - `access_mode=imported` but imported execution is not publish-ready yet
- effective `imported` when:
  - `access_mode=imported`, and
  - a successful sync has produced a valid published binding

This enables non-breaking cutover:

- user or operator can request imported mode first
- worker materializes in background
- runtime keeps serving direct queries until imported binding is ready
- once ready, runtime automatically switches to imported execution

## 5.4 Core Principle
`base_query_spec` is persisted as the logical contract.

For imported datasets, the API builds an execution-time query spec over the internal published resource. That derived execution spec is transient and must not overwrite the persisted logical `base_query_spec`.

## 5.5 Source vs Dataset Responsibility
- `datasource` is the origin registry:
  - credentials
  - ownership/workspace anchor
  - policy (`copy_policy`)
  - defaults for dataset mode
- `dataset` is the semantic and execution unit:
  - logical definition (`base_query_spec` / `view_id`)
  - imported materialization lifecycle (sync/schedule/runs)
  - runtime execution binding (`execution_datasource_id`, `execution_view_id`)

Dashboards continue to depend only on dataset contract and do not branch by source kind.

## 6. Target Architecture

## 6.1 Components
- `API Service`:
  dataset CRUD, import config CRUD, sync APIs, status APIs
- `Sync Scheduler`:
  scans schedules and enqueues due sync runs
- `Sync Worker`:
  claims runs, materializes dataset relation, publishes new version, records results
- `Lens Internal Store`:
  Postgres datasource managed by Lens
- `Engine`:
  unchanged external contract; receives effective datasource registration and execution payload

## 6.2 High-level Flow
1. User creates or updates a dataset logical definition as today.
2. User sets `access_mode=imported`.
3. Worker materializes the dataset logical relation into internal storage.
4. Worker publishes a stable internal view/resource for that dataset.
5. Worker syncs `views` and `view_columns` metadata for the internal datasource.
6. Runtime execution resolves:
   - `direct` -> origin datasource + logical dataset spec
   - `imported` -> internal datasource + published internal resource

## 7. Domain Model Changes

## 7.1 Existing entities kept
- `datasources`
- `datasets`
- `views`
- `view_columns`
- `metrics`
- `dimensions`

## 7.2 New dataset columns

### `datasets`
- `access_mode` enum:
  - `direct`
  - `imported`
  - default: `direct`
- `execution_datasource_id` FK nullable:
  - `null` for direct datasets
  - points to the Lens internal datasource for imported datasets
- `execution_view_id` FK nullable:
  - `null` for direct datasets
  - points to the published internal view registered in `views`
- `data_status` enum:
  - `draft`
  - `initializing`
  - `ready`
  - `syncing`
  - `error`
  - `drift_blocked`
  - `paused`
- `last_successful_sync_at` timestamp nullable
- `last_sync_run_id` FK nullable

Notes:

- `datasource_id` remains the origin datasource.
- `view_id` remains a legacy logical reference only.
- `execution_view_id` is the runtime binding for imported execution.
- `error` means the latest sync attempt failed; it does not by itself clear the last successfully published binding.

## 7.3 New datasource column

### `datasources`
- `copy_policy` enum:
  - `allowed`
  - `forbidden`
  - default: `allowed`
- `default_dataset_access_mode` enum:
  - `direct`
  - `imported`
  - default: `direct`

These columns define imported-mode policy and datasource defaults.

Notes:

- `default_dataset_access_mode` applies to newly created datasets for that datasource.
- Existing datasets are not rewritten implicitly by this column alone; bulk migration is explicit and auditable.

## 7.4 New tables

### `dataset_import_configs`
Operational settings only. No duplicated source-definition DSL.

- `id`
- `dataset_id` unique FK
- `refresh_mode` enum:
  - `full_refresh`
- `drift_policy` enum:
  - `block_on_breaking`
- `enabled` bool
- `max_runtime_seconds` nullable
- `state_hash`
- `created_at`, `updated_at`, `created_by_id`, `updated_by_id`

v1 rule:

- `refresh_mode` is always `full_refresh`

### `dataset_sync_schedules`
- `id`
- `dataset_id` unique FK
- `enabled` bool
- `schedule_kind` enum:
  - `cron`
  - `interval`
- `cron_expr` nullable
- `interval_minutes` nullable
- `timezone`
- `next_run_at`
- `last_run_at` nullable
- `misfire_policy` enum:
  - `run_once`
  - `skip`
- `created_at`, `updated_at`, `updated_by_id`

### `dataset_sync_runs`
Queue plus history table.

- `id`
- `dataset_id` FK
- `trigger_type` enum:
  - `initial`
  - `manual`
  - `scheduled`
  - `retry`
- `status` enum:
  - `queued`
  - `running`
  - `success`
  - `failed`
  - `drift_blocked`
  - `canceled`
  - `skipped`
- `queued_at`, `started_at`, `finished_at`
- `attempt` int
- `worker_id` nullable
- `lock_expires_at` nullable
- `input_snapshot` JSONB
- `stats` JSONB:
  - `rows_read`
  - `rows_written`
  - `bytes_processed`
- `published_execution_view_id` nullable
- `drift_summary` JSONB nullable
- `error_code` nullable
- `error_message` nullable
- `error_details` JSONB nullable
- `correlation_id` nullable

### `dataset_sync_run_events`
Optional but recommended append-only event stream.

### `dataset_schema_snapshots`
- `id`
- `dataset_id` FK
- `run_id` FK
- `logical_schema` JSONB
- `published_schema` JSONB
- `schema_hash`
- `detected_at`

v1 intentionally does not introduce checkpoints because refresh is full snapshot only.

## 8. Execution Resolution

## 8.1 Direct mode
1. Load dataset.
2. Use `dataset.datasource_id`.
3. Compose engine query spec from persisted `dataset.base_query_spec`.
4. Execute against the origin datasource.

## 8.2 Imported mode
1. Load dataset.
2. Require:
   - `execution_datasource_id`
   - `execution_view_id`
   - `data_status=ready`
3. Build a transient execution base spec over the internal published view.
4. Preserve the same semantic column names exposed by the logical dataset.
5. Execute against the internal datasource.

## 8.3 Effective mode resolution
Runtime must resolve effective execution from dataset state, not only from persisted `access_mode`.

Recommended rule:

- if `access_mode=direct`, execute `direct`
- if `access_mode=imported` and all of the following are true:
  - `execution_datasource_id` is set
  - `execution_view_id` is set
  - `last_successful_sync_at` is not null
  - `data_status` is not `draft`
  - `data_status` is not `initializing`
  - `data_status` is not `drift_blocked`
  - `data_status` is not `paused`
  then execute `imported`
- otherwise execute `direct`

This preserves availability during first import and during reconfiguration before a new publish is ready, while also preserving the last published imported binding across transient sync failures.

## 8.4 Important Rule
For imported mode, runtime may derive a transient execution query spec, but it must not overwrite the persisted logical `dataset.base_query_spec`.

## 9. Materialization Model

## 9.1 What gets materialized
The worker materializes the result of the dataset logical relation defined by:

- legacy `view_id`, or
- `base_query_spec`

The published internal resource must expose the same semantic column names used by the product.

For imported execution, the logical relation may include:
- one or more DB-origin resources
- one or more spreadsheet-origin resources
- joins among those resources

## 9.2 Workspace convergence schema
- schema:
  `lens_imp_t{workspace_id}`
- physical load tables (A/B slots):
  `ds_{dataset_id}__slot_a`
  `ds_{dataset_id}__slot_b`
- published stable view:
  `ds_{dataset_id}`

Recommendation:

- publish through a stable internal SQL view
- allow the worker to atomically swap between two fixed underlying slot tables (A/B)
- keep `execution_view_id` bound to the stable published view
- avoid unbounded storage growth from one-table-per-run materialization

All imported physical assets for the workspace must be stored under this schema, including tables originating from spreadsheet imports.

## 9.3 Metadata sync
After publish, worker must ensure corresponding rows exist and are updated in:

- `views`
- `view_columns`

for `execution_datasource_id`.

This keeps current validation and engine integration patterns reusable.

## 10. Sync Pipeline

## 10.1 Initial sync
1. Validate imported mode is allowed for the origin datasource.
2. Validate dataset logical definition.
3. Resolve the logical dataset relation graph (including joins).
4. Infer resulting schema.
5. Compare with last published schema snapshot.
6. If breaking drift is detected, stop and mark `drift_blocked`.
7. Create/load target slot table in workspace internal schema.
8. Extract rows from logical resources and load the resulting relation into internal store.
9. Publish or swap the stable internal view.
10. Sync `views` and `view_columns` metadata.
11. Update `execution_datasource_id` and `execution_view_id`.
12. Refresh `semantic_columns` if the logical contract changed as part of an approved config update.
13. Regenerate catalog metadata if needed.
14. Mark run `success` and dataset `ready`.
15. Automatic cutover starts here:
    - if `access_mode=imported`, runtime now resolves the dataset to effective `imported`
    - no explicit per-dataset manual publish step is required in v1

## 10.2 Recurring sync
Same flow as initial sync, still full refresh in v1.

Additional rule:

- if a recurring sync fails after at least one successful publish already exists, Lens keeps the last published imported binding active
- runtime does not automatically cut traffic back to `direct` on a transient refresh failure

## 10.3 Why full refresh first
This matches the current product better because it avoids:

- checkpoint correctness
- upsert semantics
- delete reconciliation
- cursor drift edge cases
- semantic inconsistency after partial refreshes

## 11. Schema Drift

## 11.1 Drift boundary
Drift is evaluated against the fields referenced by the dataset logical contract, not against arbitrary extra source columns.

If a source adds a new column that the dataset does not use, v1 ignores it.

## 11.2 Breaking drift in v1
Treat as breaking:

- removed referenced column
- renamed referenced column
- incompatible type change on referenced column
- invalidation of a logical join or computed dependency

## 11.3 v1 policy
- only `block_on_breaking`
- run becomes `drift_blocked`
- dataset becomes `drift_blocked`
- operator must update the dataset logical definition or switch back to direct mode

## 12. API Contract

## 12.1 Dataset create

### `POST /datasets`
Add fields:

- `access_mode`
- `import_config` nullable

Rules:

- existing dataset create behavior stays valid for `direct`
- for `imported`, the dataset still needs a valid logical source:
  - `view_id`, or
  - `base_query_spec`
- imported creation is rejected if origin datasource has `copy_policy=forbidden`
- direct creation must reject logical resources that depend on spreadsheet-origin imported resources
- imported creation stores the logical dataset first and enqueues an initial sync
- imported creation does not block reads:
  - until the first successful sync publishes a valid binding, effective execution remains `direct`
  - after the first successful sync, effective execution switches automatically to `imported`

## 12.2 Dataset update

### `PATCH /datasets/{id}`
Allow:

- `direct -> imported`
- `imported -> direct`
- update logical dataset definition
- update import config

Rules:

- `direct -> imported` requires valid import config and queues initial sync
- `imported -> direct` clears execution binding, disables schedule, keeps history
- changing the logical dataset definition on an imported dataset invalidates the current published binding until a new successful sync completes
- while the new binding is not ready, runtime falls back to effective `direct`

Join eligibility rules:

- if any logical resource is spreadsheet-origin, dataset execution mode must be imported
- if dataset execution mode is direct, only direct-origin resources from its datasource are valid
- imported-mode joins can combine DB-origin resources and spreadsheet-origin resources, as long as resources belong to the same workspace convergence layer

### `POST /datasources/{id}/datasets/import-enable`
Bulk-enroll existing datasets from one datasource into imported mode.

Request options:

- `dataset_ids` optional:
  - if omitted, target all eligible datasets in the datasource
- `only_if_copy_policy_allowed` default `true`
- `enqueue_initial_sync` default `true`

Behavior:

- set `access_mode=imported` for each targeted eligible dataset
- create default `dataset_import_config` where missing
- enqueue initial sync where no published binding exists yet
- do not require per-dataset manual edit
- cutover still happens per dataset only after that dataset's first successful sync

Response shape should include:

- `targeted_count`
- `updated_count`
- `skipped_count`
- `run_enqueued_count`
- per-dataset skip reasons where relevant

## 12.3 Import config
- `GET /datasets/{id}/import-config`
- `PUT /datasets/{id}/import-config`

v1 note:

- import config is operational only
- source shape remains in the dataset logical definition

## 12.4 Syncs
- `POST /datasets/{id}/syncs`
- `GET /datasets/{id}/syncs`
- `GET /datasets/{id}/syncs/{run_id}`
- `POST /datasets/{id}/syncs/{run_id}/retry`

Idempotency rule:

- only one active run per dataset
- if a manual trigger arrives while a run is already `queued` or `running`, API returns the active run and `coalesced=true`
- do not create a second active run

## 12.5 Scheduling
- `PUT /datasets/{id}/sync-schedule`
- `GET /datasets/{id}/sync-schedule`
- `DELETE /datasets/{id}/sync-schedule`

## 13. Runtime and Code Path Impact

Imported mode must be wired through all execution entrypoints, not just one route.

At minimum:

- query preview / execute
- dashboard widget execution
- batch preview
- catalog profile and data preview flows
- any path that currently resolves datasource access from `dataset.datasource`

Required refactor:

- introduce a single resolver such as `resolve_effective_dataset_access(dataset)`
- direct mode returns origin datasource context
- imported mode returns internal datasource context plus published execution view
- resolver must also return the logical authorization/workspace context anchored on the original dataset ownership, not on the internal Lens datasource

## 14. Worker and Scheduler

## 14.1 Scheduler
- periodic singleton loop
- selects due schedules
- enqueues runs idempotently
- computes next run

## 14.2 Worker
- claims queued runs with `FOR UPDATE SKIP LOCKED`
- marks run `running`
- heartbeats `lock_expires_at`
- materializes data
- publishes stable internal view
- updates execution binding
- records run outcome

## 14.3 Concurrency
- partial unique index on active runs per dataset:
  status in `queued`, `running`
- retry creates a new attempt only after the previous active run is terminal

## 15. State Machine

## 15.1 States
- `draft`
- `initializing`
- `ready`
- `syncing`
- `error`
- `drift_blocked`
- `paused`

## 15.2 Transitions
- `draft -> initializing`
- `initializing -> ready`
- `ready -> syncing -> ready`
- `syncing -> error`
- `syncing -> drift_blocked`
- `* -> paused` by explicit operator action

Rules:

- direct datasets continue to behave as today
- imported datasets may only execute from internal storage when effective mode resolves to `imported`
- `access_mode=imported` does not by itself guarantee imported execution
- a dataset with an already-published imported binding may stay effectively `imported` during `syncing` or `error`
- direct-mode datasets cannot execute joins that require spreadsheet-origin resources

## 16. Security and Compliance

1. Origin credentials remain encrypted at rest.
2. Imported mode must respect datasource `copy_policy`.
3. Worker uses read-only access to the origin datasource.
4. Internal store write access is restricted to worker/runtime identities.
5. Error payloads must be sanitized.
6. Execution logs must not leak credentials or raw secrets.
7. Dataset ownership and sharing continue to be anchored on the logical dataset, not on the internal datasource.

## 17. Observability

### Metrics
- `lens_sync_runs_total{status,trigger_type}`
- `lens_sync_run_duration_seconds`
- `lens_sync_rows_read_total`
- `lens_sync_rows_written_total`
- `lens_sync_queue_depth`
- `lens_sync_scheduler_lag_seconds`
- `lens_sync_drift_blocked_total`

### Logs
Structured logs with:

- `run_id`
- `dataset_id`
- `origin_datasource_id`
- `execution_datasource_id`
- `execution_view_id`
- `correlation_id`
- step name
- elapsed ms

### Tracing
Propagate request correlation id from API to worker and engine calls.

## 18. Rollout Plan

## Phase 1: Data model and access resolution
- add new dataset columns and new import tables
- add imported-mode validation
- implement effective dataset access resolver

## Phase 2: Manual sync and run history
- queue table semantics in `dataset_sync_runs`
- manual sync endpoint
- run detail and run list APIs

## Phase 3: Internal publish flow
- materialize dataset logical relation
- publish stable internal view
- sync internal `views` and `view_columns`
- store `execution_view_id`

## Phase 4: Runtime integration
- wire imported-mode execution through preview, batch preview, dashboards, and catalog preview flows

## Phase 5: Scheduling and hardening
- scheduler
- retries
- alerts
- retention

## 19. Acceptance Criteria

1. Creating a direct dataset keeps current behavior unchanged.
2. Creating an imported dataset still requires a valid logical dataset definition (`view_id` or `base_query_spec`).
3. `copy_policy=forbidden` blocks imported mode.
4. Initial sync creates a published internal resource and dataset transitions to `ready`.
5. Imported-mode execution uses `execution_datasource_id` and `execution_view_id`, not the origin datasource.
6. Persisted `dataset.base_query_spec` is not rewritten to the internal resource after sync.
7. Existing semantic columns, catalog, and widget references remain stable after switching to imported mode.
8. Only one active sync run can exist per dataset.
9. Repeated manual sync calls while a run is active return the same active run with `coalesced=true`.
10. Breaking drift on referenced fields marks the run and dataset as `drift_blocked`.
11. Updating the logical dataset definition for an imported dataset requires a new successful sync before imported execution becomes ready again.
12. Existing direct datasets and dashboards continue without regression.
13. Credentials do not appear in API responses, logs, or run error details.
14. Setting `access_mode=imported` on an existing dataset does not interrupt reads before the first successful sync.
15. After the first successful sync of a dataset with `access_mode=imported`, runtime automatically switches that dataset to effective imported execution.
16. A datasource-scoped bulk-enrollment operation can mark existing datasets as `imported` and enqueue their initial sync without per-dataset edits.
17. Authorization and sharing continue to be evaluated from the logical dataset ownership/workspace context even when execution uses the internal datasource.
18. Imported physical assets for a workspace are created under one internal schema (`lens_imp_t{workspace_id}`).
19. Multiple datasets over the same logical origin relation still materialize independently by dataset id.
20. An imported dataset may join DB-origin and spreadsheet-origin resources and materialize one unified dataset result.
21. A dataset anchored on a datasource with `copy_policy=forbidden` cannot transition to imported and cannot execute spreadsheet-dependent joins.

## 20. Recommended Defaults

- `access_mode`: `direct`
- `copy_policy`: `allowed`
- `refresh_mode`: `full_refresh`
- `drift_policy`: `block_on_breaking`
- scheduling disabled by default
- retry max attempts: 3
