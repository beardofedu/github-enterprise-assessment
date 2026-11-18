"""Command-line entrypoint."""

import argparse
import json
import os
import sys
from pathlib import Path

from .collector import GitHubAPIError, collect_enterprise
from .engine import CRITERIA, MANUAL, evaluate, validate_attestation
from .report import render_html
from .storage import (
    default_data_dir, demo_snapshot, load_attestations, load_snapshot,
    save_attestation, write_json,
)


def _data_dir(value):
    return Path(value).expanduser() if value else default_data_dir()


def parser():
    root = argparse.ArgumentParser(
        prog="gh-enterprise-assessment",
        description="Local, read-only GitHub Enterprise Well-Architected assessment.",
    )
    sub = root.add_subparsers(dest="command", required=True)
    demo = sub.add_parser("demo", help="Save a clearly labeled fictional fixture.")
    demo.add_argument("--data-dir")
    collect = sub.add_parser("collect", help="Collect read-only metadata from one explicit GHEC enterprise.")
    collect.add_argument("--enterprise", required=True, help="GitHub Enterprise Cloud slug.")
    collect.add_argument("--data-dir")
    attest = sub.add_parser("attest", help="Record a guided manual assessment.")
    attest.add_argument("--criterion", required=True, choices=sorted(CRITERIA))
    attest.add_argument("--level", required=True, choices=("0", "1", "2", "3", "na"))
    attest.add_argument("--note", required=True)
    attest.add_argument("--data-dir")
    report = sub.add_parser("report", help="Export the current assessment.")
    report.add_argument("--format", choices=("json", "html"), default="json")
    report.add_argument("--output")
    report.add_argument("--data-dir")
    serve = sub.add_parser("serve", help="Serve the local dashboard.")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--data-dir")
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    data_dir = _data_dir(getattr(args, "data_dir", None))
    try:
        if args.command == "demo":
            write_json(data_dir / "snapshot.json", demo_snapshot())
            print("Fictional demo assessment saved in " + str(data_dir))
        elif args.command == "collect":
            snapshot = collect_enterprise(args.enterprise)
            write_json(data_dir / "snapshot.json", snapshot)
            print(
                "Collected " + str(len(snapshot["organizations"])) + " organizations and " +
                str(len(snapshot["repositories"])) + " repository records for enterprise '" +
                args.enterprise + "' (" + snapshot["collection_status"] + ")."
            )
            if snapshot["gaps"]:
                print(str(len(snapshot["gaps"])) + " collection gap(s); see report.", file=sys.stderr)
        elif args.command == "attest":
            if args.criterion not in {c["id"] for c in MANUAL}:
                raise ValueError("This criterion requires API evidence; choose a manual criterion.")
            record = validate_attestation(args.criterion, args.level, args.note)
            save_attestation(data_dir, args.criterion, record)
            print("Evidence saved locally.")
        elif args.command == "report":
            report = evaluate(load_snapshot(data_dir), load_attestations(data_dir))
            content = json.dumps(report, indent=2, ensure_ascii=False) if args.format == "json" else render_html(report)
            if args.output:
                output = Path(args.output).expanduser()
                output.write_text(content + ("" if content.endswith("\n") else "\n"), encoding="utf-8")
                os.chmod(str(output), 0o600)
                print("Report written to " + str(output))
            else:
                print(content)
        elif args.command == "serve":
            from .web import serve
            serve(args.host, args.port, data_dir)
    except (ValueError, OSError, GitHubAPIError) as error:
        print("Error: " + str(error), file=sys.stderr)
        return 2
    return 0
