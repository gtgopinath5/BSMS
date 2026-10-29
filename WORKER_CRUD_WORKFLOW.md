# Worker CRUD Workflow (explained simply)

How a worker's account travels from a button click in the browser all the way into
the PostgreSQL database, and back. Written so anyone can follow it.

The path is always the same four steps:

```
Frontend (the web page)  →  API (the address it calls)  →  Backend service (the rules)  →  PostgreSQL (the storage)
```

- **Frontend** = the Worker Management screen the admin sees.
- **API** = a web address like `POST /api/v1/workers` the page calls.
- **Backend service** = the Python code that checks permissions and rules.
- **PostgreSQL** = the database that remembers everything.

Two rules apply to *every* action below:
1. **Branch check** — an admin may only touch workers in their **own branch**. A Master Admin may touch any branch. If you try to reach another branch you get **403 (forbidden)**.
2. **Audit** — anything that changes a worker writes a history row, so we always know *who* did *what* and *when*.

---

## 1. Create a worker

**What the admin does:** clicks **Create Worker**, fills the form (personal info,
employment info, username + password), clicks **Create**.

```
Form  →  POST /api/v1/workers  →  create_worker()  →  INSERT INTO users
```

- The backend makes sure the **username is free**.
- If no Employee ID was typed, it **makes one up** automatically: `EMP-1001`, `EMP-1002`, …
- The password is turned into a **bcrypt hash** (a scrambled version) — the real password is never saved.
- The branch is forced to the admin's own branch.
- A new row is added to `users`, and a `WORKER_CREATED` history row is written.

**Result:** the worker can now log in.

---

## 2. Read / view a worker

**What the admin does:** opens the list, or clicks a worker to open the detail drawer.

```
List page  →  GET /api/v1/workers            →  list_workers()  →  SELECT … FROM users WHERE role='worker'
Drawer     →  GET /api/v1/workers/{id}        →  get_worker()    →  SELECT one row
Drawer tabs→  GET /api/v1/workers/{id}/audit  →  worker_audit()  →  SELECT history + logins
```

An admin only sees workers from their own branch; a Master sees everyone. The password
is **never** sent to the screen.

---

## 3. Update a worker

**What the admin does:** clicks **Edit worker**, changes some fields, clicks **Save**.

```
Edit form  →  PUT /api/v1/workers/{id}  →  update_worker()  →  UPDATE users SET …
```

- Only the fields that actually changed are written.
- The backend remembers the **old value and the new value** and stores both in a
  `WORKER_UPDATED` history row (so you can see exactly what changed).

---

## 4. Delete a worker

**What the admin does:** opens the action menu and chooses **Delete permanently**, then
types `DELETE` to confirm.

```
Confirm "DELETE"  →  DELETE /api/v1/workers/{id}  →  delete_worker()  →  DELETE FROM users
```

- A normal **Admin cannot delete** — they get a **403** that tells them to *deactivate* instead.
- Only a **Master Admin** can permanently delete.
- If the worker has **real history** (service sessions, queued jobs, leave) the delete is
  **refused** with a clear message (deleting would break the reports). Deactivate instead.
- A clean account (no history) is removed, a `WORKER_DELETED` history row is kept.

---

## 5. Reset password

**What the admin does:** action menu → **Reset password**. They can click **Gen** to make
a strong one, then **Reset**.

```
New password  →  POST /api/v1/workers/{id}/reset-password  →  reset_password()  →  UPDATE users SET hashed_password = …
```

- The new password must be at least 6 characters.
- It is hashed with bcrypt before saving.
- A `WORKER_PASSWORD_RESET` history row is written — **but the password itself is never logged.**
- The worker can immediately log in with the new password; the old one stops working.

---

## 6. Lock / Unlock / Suspend / Activate / Deactivate (account status)

**What the admin does:** action menu → **Lock account** / **Deactivate** / **Activate** /
**Unlock**, then confirms.

```
Choose status  →  POST /api/v1/workers/{id}/status  →  change_status()  →  UPDATE users SET status = …
```

- `status` becomes one of `active`, `inactive`, `suspended`, `locked`.
- A `WORKER_STATUS_CHANGED` history row records the old → new status.
- **Only `active` accounts can log in** (see Login below).

---

## 7. Login

**What the worker does:** types their username and password on the login screen.

```
Username + password  →  POST /api/v1/auth/login  →  login()  →  checks users table  →  JWT token
```

Step by step inside the backend:
1. Find the user by username (or employee id, or email).
2. Check the password against the saved **bcrypt hash**.
3. **Check the status** — if the account is `locked`, `suspended`, or `inactive`, login is **refused with 403** and a friendly message.
4. If all good, build a **JWT token** containing `user_id`, `role`, and `branch_id`.
5. **Update `last_login`** to right now.
6. Write a `LOGIN` history row.

The token is what proves who the worker is on every later request, and the `branch_id`
inside it is what keeps branches separated.

---

## 8. Last-login update

This is not a separate button — it happens **automatically inside step 7**. Every time a
login succeeds, `users.last_login` is set to the current time, and a `LOGIN` row is added
to the history. That is what powers "Logged in today" on the KPI cards and the **Activity**
tab in the drawer.

---

## 9. Audit trail

Think of `audit_logs` as a **diary that can only be added to** — never edited, never erased.
Each action above writes one line:

| When this happens | The diary line says |
|---|---|
| Worker created | `WORKER_CREATED` |
| Worker edited | `WORKER_UPDATED` (with old → new) |
| Password reset | `WORKER_PASSWORD_RESET` |
| Status changed | `WORKER_STATUS_CHANGED` (old → new) |
| Worker deleted | `WORKER_DELETED` |
| Worker logs in | `LOGIN` |

Each line also records **who** did it and **when**. The drawer's **Activity** tab shows just
the `LOGIN` lines; the **Audit** tab shows the whole diary, newest first.
