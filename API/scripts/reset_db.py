"""Rebuild the bundled SQLite database from data/seed/dealership_data.json.

    python scripts/reset_db.py            # fresh database: admin login + sample data
    python scripts/reset_db.py --keep-users   # replace only the sales data, keep logins and reviews

The .db file is committed so a zip of the repo carries a ready-to-run database (POC only).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dealerpulse.config import load_settings  # noqa: E402
from dealerpulse.domain.validation import validate_dataset  # noqa: E402
from dealerpulse.infrastructure.db import create_schema, make_engine, make_session_factory  # noqa: E402
from dealerpulse.infrastructure.repositories import UnitOfWork  # noqa: E402
from dealerpulse.interfaces.http.app import SEED_FILE, create_app  # noqa: E402

DB = ROOT / "data" / "dealerpulse.db"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-users", action="store_true", help="keep logins, reviews and audit; replace sales data only")
    ap.add_argument("--seed", type=Path, default=SEED_FILE)
    a = ap.parse_args()

    data = json.loads(a.seed.read_text(encoding="utf-8"))
    result = validate_dataset(data)
    if not result.ok:
        sys.exit(f"Seed file has {result.error_count} problems, first: {result.errors[0].where} {result.errors[0].message}")

    if a.keep_users and DB.exists():
        engine = make_engine(f"sqlite:///{DB.as_posix()}")
        create_schema(engine)
        with UnitOfWork(make_session_factory(engine)) as r:
            v = r.datasets.replace(data, a.seed.name, "reset_db")
            r.audit.add("reset_db", "dataset_upload", "success", target=a.seed.name, detail={"version": v.key})
        engine.dispose()
        print(f"Replaced sales data in {DB} (version {v.key}); logins kept.")
        return

    for suffix in ("", "-wal", "-shm"):
        p = Path(str(DB) + suffix)
        if p.exists():
            p.unlink()
    # create_app creates the schema, the admin login and imports the seed on an empty database.
    app = create_app(load_settings(database_url=f"sqlite:///{DB.as_posix()}", jwt_secret="x" * 48), seed_file=a.seed)
    app.extensions["dp_engine"].dispose()  # release pooled connections before compacting
    import sqlite3
    con = sqlite3.connect(DB)
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")  # fold the WAL into the main file so one .db file is complete
    con.execute("PRAGMA journal_mode=DELETE")
    con.execute("VACUUM")
    con.close()
    print(f"Created {DB} ({DB.stat().st_size // 1024} KB): admin / Admin$123 and {result.counts['leads']} leads.")


if __name__ == "__main__":
    main()
