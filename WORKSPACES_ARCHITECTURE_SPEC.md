# Workspaces Architecture Spec for Lens Backend

## 0. Status
- Date: 2026-03-12
- Scope: Backend architecture and migration plan (no frontend design)
- Goal: Introduce `workspace` as the primary isolation boundary in Lens

---

## 1. Context and Problem

Lens today is effectively single-tenant:
- most metadata tables do not carry `workspace_id`
- access is mostly authenticated-user based, not organization-isolated
- some flows still imply global visibility (for example dashboard listings and shareable users)
- engine `workspace_id` is currently derived from `datasource.created_by_id`, which is not a real workspace model

At the same time, upcoming imported-dataset architecture requires hard data isolation by organization/environment.

This spec defines how to introduce Workspaces as a first-class backend concept without breaking existing data.

---

## 2. Workspace Concept

## 2.1 Definition
A Workspace is the primary logical boundary for data, permissions, execution context, and billing/limits in Lens.

Each workspace represents one isolated environment, for example:
- a company
- or a company environment (`prod`, `staging`, `sandbox`)

## 2.2 Responsibilities
A workspace groups and isolates:
- datasources
- views and view metadata
- datasets
- dashboards and widgets
- imports/sync jobs/history
- query execution context and engine registration
- integrations and operational limits (future quotas)

## 2.3 Non-goals (v1)
- No hard multi-database sharding by workspace in this phase.
- No external IAM/SCIM integration in this phase.

---

## 3. Target Authorization Model

## 3.1 Core model
- User can belong to multiple workspaces.
- Membership carries role per workspace.
- User has one default workspace.
- Every request with scoped resources executes against one active workspace context.

## 3.2 Roles (workspace scope)
Initial role set:
- `owner`: full control over workspace settings and members
- `admin`: manage resources and members (except removing owner)
- `editor`: create/update data assets
- `viewer`: read-only

Global `users.is_admin` remains as platform admin (cross-workspace ops, support, bootstrap), not as substitute for membership.

## 3.3 Active workspace resolution
Request workspace resolution order:
1. `X-Workspace-Id` header (explicit)
2. JWT claim `active_workspace_id`
3. `users.default_workspace_id`

Backend must always validate:
- user membership exists and is active in resolved workspace
- membership role satisfies endpoint permission

---

## 4. Data Model Changes

## 4.1 New tables

### `workspaces`
- `id` PK
- `slug` unique
- `name`
- `status` (`active`, `suspended`, `archived`)
- `owner_user_id` FK `users.id`
- `created_at`, `updated_at`

### `workspace_memberships`
- `id` PK
- `workspace_id` FK `workspaces.id`
- `user_id` FK `users.id`
- `role` (`owner`, `admin`, `editor`, `viewer`)
- `is_active` bool
- `created_at`, `updated_at`
- Unique: `(workspace_id, user_id)`

### `workspace_invitations` (optional but recommended for member lifecycle)
- `id`, `workspace_id`, `email`, `role`, `token`, `expires_at`, `status`

## 4.2 User table evolution

### `users`
- add `default_workspace_id` FK nullable (later non-null after migration)

Users remain global identities. Membership is workspace-scoped.

## 4.3 Existing tables that must receive `workspace_id`

Hard scoped:
- `datasources`
- `views`
- `datasets`
- `dashboards`
- `dashboard_widgets` (direct for faster filtering/auditing; redundant but useful)
- `dashboard_versions`
- `dashboard_edit_locks`
- `dashboard_email_shares`
- `analyses`
- `query_cache` (or derive through analysis, but explicit scoping recommended)
- `shares`
- `spreadsheet_imports` (replace `tenant_id` with `workspace_id`)
- `llm_integrations`
- `llm_integration_billing_snapshots`

Future imported dataset tables (from imported spec) must be workspace-scoped from day 1:
- `dataset_import_configs`
- `dataset_sync_schedules`
- `dataset_sync_runs`
- `dataset_sync_run_events`
- `dataset_schema_snapshots`
- `dataset_sync_checkpoints`

## 4.4 Entities that stay global
- `users`
- `auth_sessions`
- platform-level audit/config tables (if any)

## 4.5 Foreign key and integrity strategy

For strict isolation, add composite consistency constraints where needed:
- `datasets(workspace_id, datasource_id)` must reference datasource in same workspace
- `dashboards(workspace_id, dataset_id)` must reference dataset in same workspace
- `views(workspace_id, datasource_id)` must reference datasource in same workspace

Implementation approach:
- keep existing PK ids
- add unique constraints `(id, workspace_id)` on parent tables
- add composite FKs from children to `(id, workspace_id)`

This prevents cross-workspace references at DB level, not only in application code.

---

## 5. Backend Isolation Rules

## 5.1 Mandatory scoping in repositories/services
Every query over scoped entities must include `workspace_id = :active_workspace_id`.

No endpoint may list or fetch scoped resources without explicit workspace filter.

## 5.2 New auth dependency layer
Introduce dependencies:
- `get_current_user()` (existing)
- `get_workspace_context()` -> resolves and validates active workspace
- `require_workspace_role(min_role=...)`

All scoped routes use `workspace_context`.

## 5.3 Admin behavior
- Platform admin can access any workspace only when explicitly specifying workspace context.
- Platform admin should not bypass workspace filter silently.

## 5.4 Dashboard visibility semantics update
Current visibility values include `workspace_view` and `workspace_edit`, but without real workspace isolation.
After migration:
- `workspace_view` means visible to members of same workspace only
- `workspace_edit` means editable by members with role >= editor in same workspace
- `public_view` still can be public, but must resolve data only from dashboard workspace resources

---

## 6. Engine Execution Impact

## 6.1 Current gap
`workspace_id` sent to engine is derived from `datasource.created_by_id`, not a real workspace.

## 6.2 Required change
API must send real `datasource.workspace_id` (or dataset workspace) to engine service token and payload.

## 6.3 Engine side adjustments
- keep verifying `workspace_id` claim in service token (already present)
- datasource registry should key by `(workspace_id, datasource_id)` instead of only `datasource_id`
- dataset checks in engine auth path remain but now align with real workspace boundary

## 6.4 Query resolution rule
Before sending query to engine:
1. resolve active workspace context
2. load dataset constrained by workspace
3. resolve datasource constrained by workspace
4. execute with workspace-scoped token

This guarantees QuerySpec to SQL path is always workspace-correct.

---

## 7. API Design (Workspace Management)

## 7.1 Workspace endpoints
- `POST /workspaces`
  - create workspace
  - creator becomes `owner`
- `GET /workspaces`
  - list workspaces where user is active member
- `GET /workspaces/{workspace_id}`
- `PATCH /workspaces/{workspace_id}`
- `POST /workspaces/{workspace_id}/select`
  - set user default/active workspace
  - returns updated token with `active_workspace_id`

## 7.2 Membership endpoints
- `GET /workspaces/{workspace_id}/members`
- `POST /workspaces/{workspace_id}/members`
  - add member by user id or email
- `PATCH /workspaces/{workspace_id}/members/{user_id}`
  - update role/active state
- `DELETE /workspaces/{workspace_id}/members/{user_id}`

## 7.3 Auth endpoints impact
- `POST /auth/login` response should include:
  - available workspaces (id, name, role) or minimum default workspace
  - token with `active_workspace_id`
- `GET /auth/me` should include:
  - `default_workspace_id`
  - `memberships` (or summarized workspace list)

---

## 8. Migration from Current Single Workspace

## 8.1 Migration goals
- zero data loss
- no cross-workspace data exposure
- minimal API behavior break

## 8.2 Migration plan

1. Create bootstrap workspace:
- `id = 1`, `slug = default`, `name = Default Workspace`

2. Add `workspace_id` nullable columns to scoped tables.

3. Backfill:
- set `workspace_id = 1` for all existing rows in scoped tables

4. Create workspace memberships:
- all active users become members of workspace 1
- initial role mapping:
  - `users.is_admin = true` -> `owner` (or `admin`, depending governance choice)
  - others -> `editor` (or `viewer`, based on safer default)

5. Set `users.default_workspace_id = 1`.

6. Switch columns to `NOT NULL` and add indexes/FKs/composite constraints.

7. Deploy API scoping logic behind feature flag:
- `WORKSPACE_ENFORCEMENT_ENABLED=false` during dual-read period
- enable after migration verification

8. Enable strict enforcement and remove fallback paths.

## 8.3 Compatibility window
During transition:
- if token has no `active_workspace_id`, backend falls back to `default_workspace_id`
- logs warning with correlation id for observability

---

## 9. Endpoint-by-Endpoint Scoping Requirements

## 9.1 Datasources
- create/list/get/update/delete/sync filtered by workspace
- uniqueness can become `(workspace_id, name)`

## 9.2 Views and View Columns
- views must inherit datasource workspace
- schema fetch endpoints must validate workspace on datasource/view

## 9.3 Datasets
- CRUD filtered by workspace
- dataset datasource relationship constrained to same workspace

## 9.4 Dashboards
- list/get/save/share constrained by workspace
- `shareable-users` should list only active users in workspace (not global users)

## 9.5 Query endpoints
- dataset lookup scoped by workspace
- datasource resolution scoped by workspace
- engine call uses workspace from context

## 9.6 Imports and jobs
- replace `tenant_id` semantics with `workspace_id`
- access checks by membership role instead of only `created_by_id`

---

## 10. Preparation for Imported Datasets

Workspace model must support future imported-dataset needs:

1. Internal storage partitioning
- internal schemas/tables namespaced by workspace id (for example `lens_ws_{workspace_id}`)

2. Workspace quotas and limits (future)
- max imported rows
- max storage bytes
- max concurrent sync jobs

3. Isolated ingestion execution
- sync workers always run with workspace context
- run history and checkpoints keyed by workspace + dataset

4. Billing and governance
- usage metrics aggregated by workspace

---

## 11. Security and Observability Requirements

## 11.1 Security
- no scoped endpoint should execute without workspace context
- enforce membership checks before resource access
- prevent IDOR by always combining `(id, workspace_id)` in reads
- sanitize errors to avoid leaking cross-workspace existence

## 11.2 Observability
Add structured fields in logs/metrics:
- `workspace_id`
- `user_id`
- `resource_type`, `resource_id`
- `authz_result` (`allow`, `deny`)

Recommended metrics:
- `workspace_authz_denied_total`
- `workspace_scoped_query_total`
- `workspace_switch_total`

---

## 12. Rollout Strategy (Phased)

## Phase 1: Data model foundation
- add `workspaces`, `workspace_memberships`, `users.default_workspace_id`
- add `workspace_id` nullable to scoped tables
- create bootstrap workspace and backfill ids

## Phase 2: Membership and auth context
- add workspace context dependency and role checks
- add login/me payload changes and workspace-select endpoint
- emit tokens with `active_workspace_id`

## Phase 3: Scoped APIs and service layer
- update all routers/services to enforce workspace scoping
- update dashboard sharing semantics to real workspace boundaries
- update imports from `tenant_id` to `workspace_id`

## Phase 4: Engine alignment
- send real workspace id to engine tokens/payload
- update engine registry keying and checks

## Phase 5: Hard enforcement and cleanup
- set `workspace_id` NOT NULL
- enforce composite FKs
- remove compatibility fallback
- finalize docs and runbook

---

## 13. Acceptance Criteria

1. Any authenticated user with no membership in workspace X cannot list or read resources from workspace X.
2. Datasource, dataset, view, dashboard, import, and analysis CRUD is fully workspace-scoped.
3. Engine execution always receives and validates real workspace id.
4. `shareable-users` endpoint only returns users in current workspace.
5. Existing production data is fully migrated into bootstrap workspace with no loss.
6. Legacy tokens without workspace claim continue working during transition via default workspace fallback.
7. After enforcement phase, all scoped tables have non-null `workspace_id` and referential integrity in place.
8. Imported dataset future tables are designed with workspace_id as mandatory field from first migration.

---

## 14. Risks and Mitigations

Risk: missing workspace filters in some endpoints.
- Mitigation: central dependency + repository helpers + integration tests for cross-workspace access denial.

Risk: migration introduces invalid cross-table relations.
- Mitigation: two-step migration (backfill, validate, then enforce constraints).

Risk: engine cache/registry collision across workspaces.
- Mitigation: key registry by `(workspace_id, datasource_id)`.

Risk: permission confusion between platform admin and workspace role.
- Mitigation: explicit policy table and endpoint-level tests.

---

## 15. Implementation Notes for Current Codebase

Based on current backend:
- replace pseudo workspace derivation in `app/modules/engine/access.py`:
  - from `workspace_id = datasource.created_by_id`
  - to `workspace_id = datasource.workspace_id`
- extend auth token generation in `app/api/v1/routes/auth.py` and decode dependencies to carry workspace context
- refactor routes currently returning global resources (`datasets`, `dashboards`, `views`, `shareable-users`, `catalog`) to mandatory workspace filtering
- replace `spreadsheet_imports.tenant_id` usages in imports module with workspace context

This sequence is the required prerequisite before implementing imported datasets at enterprise isolation level.

