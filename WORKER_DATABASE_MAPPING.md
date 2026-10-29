# Worker Database Mapping

Every Worker Management field, from the form the admin fills in, through the API
request body, down to the exact PostgreSQL column it lands in — plus the rule that
field must satisfy.

All worker data lives in one table: **`users`** (the same table holds master admins,
admins and workers; `role` distinguishes them). Two related tables are touched:
**`bays`** (for the worker's assigned bay) and **`audit_logs`** (for history).

## Create / Edit Worker form

| Frontend field | API field | Database column | Validation rules |
|---|---|---|---|
| Full Name | `name` | `users.name` | **required** |
| Mobile Number | `mobile` | `users.mobile` | optional · digits / `+` (≥ 8) |
| Email | `email` | `users.email` | optional |
| Address | `address` | `users.address` | optional |
| Aadhaar Number | `aadhaar` | `users.aadhaar` | optional · exactly 12 digits |
| Emergency Contact | `emergency_contact` | `users.emergency_contact` | optional |
| Date Of Birth | `dob` | `users.dob` *(DATE)* | optional · `YYYY-MM-DD` |
| Employee ID | `employee_id` | `users.employee_id` | **auto-generated** `EMP-NNNN` when blank · unique |
| Branch | `branch_id` | `users.branch_id` *(FK → branches.id)* | taken from the admin's branch (Master may pick) |
| Department | `department` | `users.department` | dropdown: Service Technician · Senior Technician · Supervisor · Store Manager |
| Designation | `designation` | `users.designation` | optional |
| Assigned Bay | *(handled via bay)* | `bays.primary_worker_id` *(FK → users.id)* | optional · set with `PUT /bays/{id}` after create |
| Joining Date | `joining_date` | `users.joining_date` *(DATE)* | optional · defaults to record-creation date |
| Employment Status | `status` | `users.status` | one of `active` · `inactive` · `suspended` · `locked` |
| Username | `username` | `users.username` | **required** · **unique** |
| Password | `password` | `users.hashed_password` | **required** · ≥ 6 chars · stored as a **bcrypt hash** (never plain text) |
| Role | `role` | `users.role` | fixed to `worker` |

## System-managed columns (not entered by hand)

| Meaning | Database column | How it is set |
|---|---|---|
| Last login time | `users.last_login` *(TIMESTAMP)* | stamped automatically every successful login |
| Created at | `users.created_at` | set when the row is inserted |
| Updated at | `users.updated_at` | bumped on every change |
| Join date (shown in UI) | derived | `joining_date` if set, otherwise the `created_at` date |

## Password reset / account status

| Action | API field | Database column | Rule |
|---|---|---|---|
| Reset Password | `new_password` | `users.hashed_password` | ≥ 6 chars · re-hashed with bcrypt · the password is **never** logged |
| Lock / Unlock / Suspend / Activate / Deactivate | `status` | `users.status` | must be one of the four allowed values |

## History (`audit_logs`)

Every create / update / password-reset / status-change / delete / login writes one
append-only row:

| Column | Holds |
|---|---|
| `action` | `WORKER_CREATED` · `WORKER_UPDATED` · `WORKER_PASSWORD_RESET` · `WORKER_STATUS_CHANGED` · `WORKER_DELETED` · `LOGIN` |
| `entity_type` | `"user"` |
| `entity_id` | the worker's id |
| `changed_by` | the admin who did it (or the worker's own id for `LOGIN`) *(FK → users.id)* |
| `old_value` / `new_value` | JSON of what changed (old → new); passwords are **never** stored |
| `timestamp` | when it happened |
