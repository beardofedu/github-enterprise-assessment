"""Local JSON persistence. Credentials are never written to disk."""

import json
import os
from pathlib import Path

from .engine import RUBRIC_VERSION, SNAPSHOT_VERSION, timestamp


def default_data_dir():
    return Path(os.environ.get(
        "GH_ASSESSMENT_HOME",
        str(Path.home() / ".local" / "share" / "gh-enterprise-assessment"),
    ))


def _secure_dir(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)


def read_json(path, default):
    if not path.exists():
        return default
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def write_json(path, data):
    _secure_dir(path.parent)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", encoding="utf-8") as stream:
        os.chmod(str(temp), 0o600)
        json.dump(data, stream, indent=2, sort_keys=True)
        stream.write("\n")
    os.replace(str(temp), str(path))


def load_snapshot(data_dir):
    snapshot = read_json(Path(data_dir) / "snapshot.json", None)
    if snapshot is None:
        raise FileNotFoundError("No assessment snapshot yet. Run `python -m assessment demo` or `collect`.")
    return snapshot


def load_attestations(data_dir):
    return read_json(Path(data_dir) / "attestations.json", {})


def save_attestation(data_dir, criterion_id, record):
    path = Path(data_dir) / "attestations.json"
    records = read_json(path, {})
    records[criterion_id] = record
    write_json(path, records)


def demo_snapshot():
    repos = [
        ("octodemo/web-store", False, "enabled", "disabled"),
        ("octodemo/api-service", False, "enabled", "enabled"),
        ("octodemo/legacy-tools", False, "disabled", "disabled"),
        ("octodemo/archived-demo", True, None, None),
        ("octodemo/private-service", False, None, None),
    ]
    repositories = []
    for name, archived, scanning, protection in repos:
        status = "inaccessible" if scanning is None and not archived else "collected"
        detail = "Repository metadata endpoint was not available in this fixture." if status == "inaccessible" else ""
        settings = {}
        if scanning:
            settings = {
                "secret_scanning": scanning,
                "secret_scanning_push_protection": protection,
            }
        repositories.append({
            "name": name, "archived": archived, "status": status, "detail": detail,
            "settings": settings, "observed_at": timestamp(),
        })
    return {
        "schema_version": SNAPSHOT_VERSION,
        "rubric_version": RUBRIC_VERSION,
        "mode": "demo",
        "host": "github.com",
        "enterprise": "example-demo",
        "collected_at": timestamp(),
        "collection_status": "partial",
        "organizations": ["octodemo"],
        "repositories": repositories,
        "gaps": [{
            "scope": "octodemo/private-service",
            "status": "inaccessible",
            "detail": "Repository metadata endpoint was not available in this fixture.",
        }],
    }
