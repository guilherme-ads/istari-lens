# Lens Backend Spec: Direct vs Imported Dataset Access

## 1. Objective
Evolve Lens backend to support two explicit dataset access modes:

- `direct` (current): queries execute against customer-connected datasource.
- `imported` (new): selected data is ingested into Lens-managed internal storage and queries execute there.

Importing must be optional and explicit at datasource/dataset configuration level, because some customers do not allow data copy.

---

## 2. Scope

### In scope
- Dataset access mode selection and enforcement (`direct` vs `imported`).
- Selective ingestion definition:
  - source table/view/query
  - selected columns
  - row filters
  - primary key
  - incremental strategy (when possible)
- Initial load and future syncs.
- Manual and scheduled sync.
- Async ingestion jobs.
- Internal imported data storage model.
- Sync history, status, and errors.
- Schema drift detection and handling.
- Dataset resolution for query execution based on mode.
- APIs, state machine, observability, and security.

### Out of scope
- Frontend/UX design.
- CDC-logical replication v1 (Debezium/Kafka etc).
- Cross-datasource joins in imported pipeline v1.

---

## 3. Guiding Architecture Decisions

1. Explicit mode, never implicit copy.
2. Backward compatibility for existing direct datasets.
3. Async ingestion with reliable state persisted in DB.
4. Storage-agnostic execution path: query layer resolves effective datasource based on mode.
5. Safe-by-default ingestion (read-only source access, parameterized filters, auditable runs).
6. Drift-aware sync: additive drift may auto-apply by policy; breaking drift blocks sync.

---

## 4. Target Architecture

## 4.1 Components
- `API Service` (FastAPI):
  - CRUD dataset/import config
  - trigger manual sync
  - expose run history and status
  - manage schedule
- `Sync Scheduler` (new process):
  - scans due schedules
  - enqueues sync runs
- `Sync Worker` (new process, N replicas):
  - claims queued runs (`FOR UPDATE SKIP LOCKED`)
  - executes extraction, transform, load, merge
  - records status/errors/drift
- `Lens Internal Store` (Postgres; can reuse analytics DB in v1):
  - imported tables in dedicated schema(s)
- `Engine`:
  - unchanged API contract
  - receives effective datasource URL registered by API

## 4.2 Why DB-backed queue first
Implement queue/scheduling using product DB tables + row locking:
- avoids immediate Redis/Celery dependency
- strong transactional consistency between run creation and state updates
- simpler operations for current stack

Future migration path: move to external queue while preserving run table as source of truth.

---

## 5. Domain Model Changes

## 5.1 Existing entities
- Keep `datasources`, `datasets`, `views`, `view_columns`.

## 5.2 New columns

### `datasources`
- `copy_policy` enum:
  - `forbidden` (cannot create imported datasets from this source)
  - `allowed` (default)
  - `required` (optional future use for managed sources)

### `datasets`
- `access_mode` enum: `direct | imported` (default `direct`)
- `execution_datasource_id` FK nullable:
  - `null` in direct mode (effective datasource = `datasource_id`)
  - set in imported mode (Lens internal datasource)
- `data_status` enum:
  - `draft | initializing | ready | syncing | stale | error | drift_blocked | paused`
- `last_successful_sync_at` timestamp nullable
- `last_sync_run_id` FK nullable
- `next_scheduled_sync_at` timestamp nullable (denormalized convenience)

`datasource_id` remains the origin datasource selected by customer.

## 5.3 New tables

### `dataset_import_configs` (1:1 with dataset)
- `id`
- `dataset_id` (unique FK)
- `origin_datasource_id` FK (must match dataset.datasource_id)
- `source_kind` enum: `table | view | query`
- `source_schema` nullable
- `source_object` nullable
- `source_query_sql` nullable (only SELECT/CTE; validated)
- `selected_columns` JSONB (ordered list)
- `row_filter` JSONB (Lens filter DSL)
- `primary_key_columns` JSONB (1..N)
- `incremental_mode` enum:
  - `full_refresh`
  - `append_by_cursor`
  - `upsert_by_cursor`
- `incremental_cursor_column` nullable
- `incremental_cursor_type` enum nullable: `timestamp | numeric | lexicographic`
- `incremental_lookback_seconds` int default 0
- `delete_strategy` enum:
  - `none`
  - `hard_delete_missing` (only allowed with full snapshot)
- `drift_policy` enum:
  - `block_on_breaking`
  - `auto_apply_additive`
  - `auto_apply_all_compatible`
- `state_hash` string (hash of config for idempotency)
- `created_at`, `updated_at`, `created_by_id`, `updated_by_id`

### `dataset_sync_schedules`
- `id`
- `dataset_id` FK unique
- `enabled` bool
- `schedule_kind` enum: `cron | interval`
- `cron_expr` nullable
- `interval_minutes` nullable
- `timezone`
- `next_run_at`
- `last_run_at` nullable
- `misfire_policy` enum: `run_once | skip`
- `created_at`, `updated_at`, `updated_by_id`

### `dataset_sync_runs` (history + queue)
- `id`
- `dataset_id` FK
- `trigger_type` enum: `initial | manual | scheduled | retry | api`
- `status` enum:
  - `queued | running | success | failed | partial_success | drift_blocked | canceled | skipped`
- `queued_at`, `started_at`, `finished_at`
- `attempt` int
- `worker_id` nullable
- `lock_expires_at` nullable
- `input_snapshot` JSONB (immutable import config snapshot used by run)
- `stats` JSONB:
  - `rows_read`, `rows_written`, `rows_upserted`, `rows_deleted`, `bytes_processed`
- `checkpoint_before` JSONB nullable
- `checkpoint_after` JSONB nullable
- `schema_snapshot_id` nullable
- `drift_summary` JSONB nullable
- `error_code` nullable
- `error_message` nullable (sanitized)
- `error_details` JSONB nullable (non-sensitive)
- `correlation_id` nullable

### `dataset_sync_run_events` (optional but recommended)
- append-only step log per run:
  - `extract_started`, `extract_finished`, `load_started`, `merge_finished`, etc.

### `dataset_schema_snapshots`
- `id`
- `dataset_id` FK
- `run_id` FK
- `source_schema` JSONB (column names/types/nullability/order)
- `target_schema` JSONB
- `schema_hash`
- `detected_at`

### `dataset_sync_checkpoints`
- `dataset_id` PK
- `cursor_value` (string/json)
- `cursor_type`
- `updated_at`
- `updated_by_run_id`

---

## 6. Dataset State Machine

## 6.1 States
- `draft`: imported dataset configured, no successful initial load.
- `initializing`: first run queued/running.
- `ready`: at least one successful run.
- `syncing`: a run is running.
- `stale`: sync overdue (scheduler lag / max staleness breached).
- `error`: last run failed and retry budget exhausted.
- `drift_blocked`: run stopped due to breaking schema drift.
- `paused`: schedule disabled and manual sync blocked by policy.

## 6.2 Core transitions
- `draft -> initializing` on first enqueue.
- `initializing -> ready` on success.
- `ready -> syncing -> ready` on successful recurring sync.
- `syncing -> drift_blocked` when drift policy blocks.
- `syncing -> error` on failed run.
- `ready -> stale` when overdue threshold exceeded.
- `* -> paused` by admin action.

Direct datasets keep `access_mode=direct` and `data_status=ready` semantics.

---

## 7. Ingestion Pipeline

## 7.1 Initial load
1. Validate import config snapshot.
2. Resolve source SQL:
   - table/view: generate `SELECT <cols> FROM schema.object WHERE <filters>`
   - query: wrap user query as subquery + apply projection/filter guardrails
3. Infer source schema (`LIMIT 0`).
4. Drift check vs previous snapshot (none in first run).
5. Create staging table in internal schema.
6. Stream/extract batches from origin and load into staging (COPY where possible).
7. Publish into target table:
   - full refresh: atomic swap/rename pattern
   - incremental: MERGE/UPSERT into stable target
8. Update `views` and `view_columns` metadata for execution datasource.
9. Rebuild dataset `base_query_spec` to target resource.
10. Persist checkpoint and mark run success.

## 7.2 Future syncs
- Same flow with checkpoint-aware extraction:
  - `append_by_cursor`: read `cursor > last_cursor - lookback`
  - `upsert_by_cursor`: same extraction + upsert by PK
- Idempotency:
  - deterministic run input hash
  - safe retry semantics

## 7.3 Incremental support matrix
- Requires:
  - primary key configured (`upsert_by_cursor`)
  - monotonic cursor column configured
- If not available:
  - force `full_refresh` (explicitly reflected in run reason/outcome)

---

## 8. Schema Drift Detection

## 8.1 Drift types
- Additive:
  - new nullable column
- Compatible change:
  - widening numeric/text type
- Breaking:
  - removed column
  - narrowed/incompatible type
  - PK column changed/removed

## 8.2 Behavior by `drift_policy`
- `block_on_breaking`:
  - additive auto-apply optional; breaking -> `drift_blocked`
- `auto_apply_additive`:
  - additive applied automatically, breaking blocked
- `auto_apply_all_compatible`:
  - additive + compatible type widening auto-applied, breaking blocked

## 8.3 Resolution
- API exposes drift payload and required actions.
- Operator may:
  - acknowledge + apply config update
  - force full refresh (if safe)
  - pause dataset

---

## 9. Effective Datasource Resolution (`direct` vs `imported`)

At query execution time:

1. Load dataset.
2. If `access_mode=direct`:
   - effective datasource = `dataset.datasource_id`.
3. If `access_mode=imported`:
   - effective datasource = `dataset.execution_datasource_id` (Lens internal store).
4. Compose engine query spec from dataset `base_query_spec` (already pointing to imported target resource in imported mode).
5. Register effective datasource URL in engine and execute.

This keeps engine contract stable and isolates mode resolution inside API domain layer.

---

## 10. API Contract (Backend)

## 10.1 Dataset create/update

### `POST /datasets`
- Add fields:
  - `access_mode`
  - `import_config` (required when `access_mode=imported`)
- Validations:
  - origin datasource `copy_policy != forbidden`
  - required primary key/cursor constraints by incremental mode

### `PATCH /datasets/{id}`
- allow mode switch with guardrails:
  - `direct -> imported`: requires valid import config + initial load run queued
  - `imported -> direct`: keeps history, disables schedule, switches execution datasource to null

## 10.2 Import config
- `GET /datasets/{id}/import-config`
- `PUT /datasets/{id}/import-config`
- `POST /datasets/{id}/import-config/validate`
  - dry-run schema introspection and estimated row count (bounded)

## 10.3 Sync operations
- `POST /datasets/{id}/syncs`
  - enqueue manual sync
  - optional `force_full_refresh`, `reason`
- `GET /datasets/{id}/syncs`
  - paginated run history
- `GET /datasets/{id}/syncs/{run_id}`
  - run details + steps + drift + stats
- `POST /datasets/{id}/syncs/{run_id}/retry`

## 10.4 Scheduling
- `PUT /datasets/{id}/sync-schedule`
- `GET /datasets/{id}/sync-schedule`
- `DELETE /datasets/{id}/sync-schedule` (disables)

## 10.5 Drift
- `GET /datasets/{id}/drift`
- `POST /datasets/{id}/drift/resolve`
  - action: `accept_additive`, `force_refresh`, `pause`

---

## 11. Worker and Scheduler Implementation

## 11.1 Scheduler loop
- Every 30-60 seconds:
  - acquire advisory lock (`scheduler_singleton`)
  - select due enabled schedules
  - enqueue runs idempotently (unique key: dataset + scheduled window)
  - compute next_run_at

## 11.2 Worker loop
- Poll queued runs with:
  - `SELECT ... FOR UPDATE SKIP LOCKED LIMIT N`
- Mark as running with `started_at`, `worker_id`, `lock_expires_at`.
- Execute pipeline with heartbeat update.
- On completion: update run, dataset state, checkpoints, snapshots.
- Crash recovery:
  - stale `running` runs with expired lock are requeued with incremented `attempt`.

## 11.3 Concurrency controls
- One active run per dataset:
  - DB partial unique index on `(dataset_id)` where status in (`queued`,`running`).
- Cross-worker mutual exclusion by row lock.

---

## 12. Internal Storage Model

## 12.1 Datasource
- Managed internal datasource per tenant/workspace:
  - `source_type = lens_internal_import_store`
  - URL from internal store setting (encrypted at rest)

## 12.2 Schemas and tables
- Schema naming:
  - `lens_imp_t{tenant_id}`
- Stable target table:
  - `ds_{dataset_id}`
- Staging table:
  - `ds_{dataset_id}__stg_{run_id}`
- Indexes:
  - PK index (configured columns)
  - cursor index for incremental

## 12.3 Metadata sync
- Ensure corresponding `views`/`view_columns` rows are maintained under `execution_datasource_id` so existing validation/composition remains consistent.

---

## 13. Security and Compliance

1. Origin connection credentials remain encrypted.
2. Source query must be read-only:
   - single statement
   - starts with `SELECT`/`WITH`
   - deny DDL/DML tokens
3. Source DB role for import must be read-only.
4. Internal store writes restricted to worker identity.
5. All run errors sanitized (never leak credentials/SQL secrets).
6. Audit fields on all config/schedule changes (`updated_by`, timestamps).
7. Optional data retention:
   - limit historical run payload size
   - configurable purge for old run logs.

---

## 14. Observability

## 14.1 Metrics
- `lens_sync_runs_total{status,trigger_type}`
- `lens_sync_run_duration_seconds{dataset_id}`
- `lens_sync_rows_read_total{dataset_id}`
- `lens_sync_rows_written_total{dataset_id}`
- `lens_sync_drift_events_total{drift_type}`
- `lens_sync_scheduler_lag_seconds`
- `lens_sync_queue_depth`

## 14.2 Logs
- Structured logs with:
  - `run_id`, `dataset_id`, `origin_datasource_id`, `execution_datasource_id`
  - `correlation_id`
  - step name and elapsed ms

## 14.3 Tracing
- Propagate `x-correlation-id` from API to worker and engine registration/execution.

---

## 15. Failure Handling and Retries

1. Retryable errors:
   - transient network/database timeouts
   - lock/contention errors
2. Non-retryable:
   - invalid config
   - breaking drift (unless resolved)
3. Retry policy:
   - exponential backoff
   - max attempts per run (configurable, default 3)
4. Dead-letter behavior:
   - run marked `failed`
   - dataset moves to `error`
   - alert emitted.

---

## 16. Rollout Plan

## Phase 1: Data model + API contracts
- migrations for new columns/tables/enums
- dataset mode/config endpoints with validation

## Phase 2: Worker + scheduler + run history
- queue logic in `dataset_sync_runs`
- manual sync endpoint enqueueing
- run status endpoints

## Phase 3: Initial load + query resolution
- internal table publish flow
- execution datasource resolution in query path
- metadata registration (`views`/`view_columns`)

## Phase 4: Incremental + drift
- checkpoint logic
- drift detection/policies
- drift resolution endpoints

## Phase 5: Hardening
- retries, alerting, retention jobs, performance tuning

---

## 17. Acceptance Criteria

1. Creating dataset with `access_mode=direct` keeps current behavior unchanged.
2. Creating dataset with `access_mode=imported` without explicit import config is rejected (`400`).
3. Datasource with `copy_policy=forbidden` blocks imported dataset creation.
4. Manual sync endpoint enqueues job and returns run id immediately.
5. Initial sync creates internal target table and dataset transitions to `ready`.
6. Query execution for imported dataset uses internal execution datasource, not origin datasource.
7. Scheduled sync creates runs according to cron/interval and records trigger type `scheduled`.
8. Run history endpoint returns status timeline, stats, and error payloads.
9. Failing sync updates run to `failed` and dataset state to `error` (or stays `ready` if policy configured for soft-fail).
10. Drift detection identifies additive and breaking changes distinctly.
11. Breaking drift sets run `drift_blocked` and dataset state `drift_blocked`.
12. Additive drift auto-applies when policy allows and run can complete successfully.
13. Incremental mode without PK/cursor is rejected at config validation.
14. Only one active run per dataset exists at any time, even with concurrent manual triggers.
15. Credentials never appear in API responses, logs, or run error details.
16. Existing dashboards/widgets querying direct datasets continue funcionando sem regressao.

---

## 18. Recommended Defaults (v1)

- `access_mode`: `direct`
- `copy_policy`: `allowed`
- `incremental_mode`: `full_refresh`
- `drift_policy`: `block_on_breaking`
- scheduler disabled by default for imported dataset until first successful sync
- run retry max attempts: 3
