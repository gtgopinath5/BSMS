"""Minimal real bootstrap — configuration only, no transactional demo data.

Seeds just enough to log in and operate:
  - 4 branches
  - 1 master admin + 1 branch admin
  - the operating crew (workers) for Chennai
  - the 8-bay layout for Chennai (primary worker assigned)
  - a default unit-conversion setting

It deliberately seeds NO customers, jobs, queue items, completions, recordings
or parts — those are created at runtime through the UI/API (admins import the
real parts catalog; customers/jobs appear as real work comes in).

Idempotent — does nothing if any user already exists.

Default credentials (username / password):
    master / master123        admin / admin123        worker / worker123
"""
from sqlalchemy import select
from .database import SessionLocal
from .models.branch import Branch
from .models.user import User, UserRole
from .models.bay import Bay
from .models.part import UnitConversionSetting
from .utils.security import hash_password

BRANCHES = [
    ("LOC_CHN_01", "Chennai", "Tamil Nadu"),
    ("LOC_VPM_02", "Villupuram", "Tamil Nadu"),
    ("LOC_PDY_03", "Pondicherry", "Puducherry"),
    ("LOC_MUM_04", "Mumbai", "Maharashtra"),
]

# Operating crew = configuration (a service center has staff). Not demo "data".
WORKERS = [
    ("EMP-802", "Karthik Rajan", "worker"),
    ("EMP-815", "S. Murugan", "emp-815"),
    ("EMP-790", "Imran Khan", "emp-790"),
    ("EMP-808", "Arjun P.", "emp-808"),
]


def seed() -> None:
    db = SessionLocal()
    try:
        if db.scalar(select(User).limit(1)):
            return  # already bootstrapped

        for bid, name, loc in BRANCHES:
            db.add(Branch(id=bid, name=name, location=loc))
        db.flush()

        db.add(UnitConversionSetting(value_minutes=1.0, records_affected=0))

        db.add(User(name="Global Command", role=UserRole.master_admin, employee_id="MA-001",
                    username="master", hashed_password=hash_password("master123")))
        db.add(User(name="A. Krishnan", role=UserRole.admin, branch_id="LOC_CHN_01",
                    employee_id="ADMIN-014", username="admin", hashed_password=hash_password("admin123")))

        worker_ids = []
        for emp, name, uname in WORKERS:
            u = User(name=name, role=UserRole.worker, branch_id="LOC_CHN_01", employee_id=emp,
                     username="worker" if emp == "EMP-802" else uname,
                     hashed_password=hash_password("worker123"))
            db.add(u); db.flush()
            worker_ids.append(u.id)

        # 8-bay layout for Chennai (primary worker on the first four)
        for n in range(1, 9):
            primary = worker_ids[n - 1] if n <= len(worker_ids) else None
            db.add(Bay(bay_number=n, branch_id="LOC_CHN_01", primary_worker_id=primary, status="available"))

        db.commit()
        print("[seed] minimal bootstrap ready (branches + admin/master + crew + bays). "
              "No demo jobs/customers/recordings.")
    finally:
        db.close()
