"""Versioned rubric and deterministic scoring with no network or UI dependencies."""

from datetime import datetime, timezone

RUBRIC_VERSION = "1.0.0"
SNAPSHOT_VERSION = 1
REPORT_VERSION = 1
DISCLAIMER = "Project-defined maturity scale; not an official GitHub score or certification."
LEVELS = {0: "Missing", 1: "Ad hoc", 2: "Established", 3: "Managed"}
STATUSES = ("assessed", "unknown", "inaccessible", "incomplete", "not_applicable")
WAF = "https://learn.github.com/well-architected/"
PILLARS = {
    "productivity": "Productivity",
    "collaboration": "Collaboration",
    "application-security": "Application Security",
    "governance": "Governance",
    "architecture": "Architecture",
}


def _criterion(identifier, pillar, title, guidance, evidence, remediation, priority,
               rationale, field=None, source_path=None):
    return {
        "id": identifier,
        "pillar": pillar,
        "title": title,
        "guidance": guidance,
        "evidence": evidence,
        "remediation": remediation,
        "priority": priority,
        "rationale": rationale,
        "field": field,
        "source": WAF + (source_path or pillar + "/checklist"),
        "scope": "repository" if field else "selected assessment scope",
        "applicability": (
            "Visible, non-archived repositories; only explicit supported settings are scored."
            if field else "Selected assessment scope; document a rationale for exclusions."
        ),
    }


RUBRIC = (
    _criterion("PROD-01", "productivity", "Standard CI feedback",
               "Adopt repeatable CI and measure the time to useful feedback.",
               "Describe the CI baseline, representative adoption, ownership, and review of feedback time or flakiness.",
               "Pilot a reusable build/test workflow and baseline time to first feedback; review adoption and flaky checks.",
               "Medium", "Inconsistent or slow checks delay delivery and make failures harder to trust.",
               source_path="productivity/recommendations/effective-ci"),
    _criterion("COLL-01", "collaboration", "Code review practice",
               "Formalize review expectations and train contributors in the workflow.",
               "Reference review expectations, onboarding materials, a sample of recent reviews, and exception handling.",
               "Publish review expectations and examples, assign reviewer ownership, and review turnaround and exceptions.",
               "Medium", "A consistent review practice improves knowledge sharing and change quality."),
    _criterion("SEC-01", "application-security", "Secret scanning configuration",
               "Detect supported secrets in repositories.",
               "Explicit security_and_analysis.secret_scanning.status in repository metadata.",
               "Confirm eligibility and enable secret scanning; assign owners for triage and credential rotation.",
               "High", "Delayed detection can extend the time an exposed credential is usable.",
               "secret_scanning"),
    _criterion("SEC-02", "application-security", "Push protection configuration",
               "Prevent supported secrets from entering repository history.",
               "Explicit security_and_analysis.secret_scanning_push_protection.status in repository metadata.",
               "Enable push protection on eligible repositories; document bypass criteria and review bypass activity.",
               "High", "Preventing exposure is safer than relying on detection after a push.",
               "secret_scanning_push_protection",
               "application-security/recommendations/enforce-ghas-at-scale"),
    _criterion("SEC-03", "application-security", "Security alert response",
               "Assign owners and prioritize remediation for security alerts.",
               "Reference triage ownership, a recent response or exercise, remediation targets, and overdue exception review.",
               "Define a triage queue, severity targets, and a recurring review of aged alerts and accepted exceptions.",
               "High", "Scanning alone does not ensure an exposed secret or vulnerability is addressed."),
    _criterion("GOV-01", "governance", "Audit monitoring and retention",
               "Retain audit events appropriately and regularly review them for unusual activity.",
               "Reference retention policy, monitoring owner and cadence, and a recent alert review or monitoring exercise.",
               "Assign the monitoring owner, align retention to requirements, and exercise an alert-to-investigation workflow.",
               "High", "Missing retention or monitoring can prevent timely detection and reconstruction of incidents."),
    _criterion("GOV-02", "governance", "Branch policy and exceptions",
               "Verify required reviews and status checks apply to critical branches.",
               "Sample critical branches and inspect active inherited rulesets, branch protections, required checks, and bypasses.",
               "Define critical branch baselines, check effective settings and bypass actors, and track approved exceptions.",
               "High", "Uncontrolled changes to critical branches can bypass review and verification."),
    _criterion("ARCH-01", "architecture", "Recovery exercises",
               "Test recovery of critical GitHub data and configurations.",
               "Reference asset inventory, recovery objectives, runbook, and date/outcome of a recent restore exercise.",
               "Identify critical assets and recovery objectives, exercise a safe restore, and assign follow-up actions.",
               "High", "Untested recovery can prolong disruption or leave critical assets unrecoverable."),
)
CRITERIA = {criterion["id"]: criterion for criterion in RUBRIC}
MANUAL = tuple(c for c in RUBRIC if c["field"] is None)
AUTO = tuple(c for c in RUBRIC if c["field"] is not None)


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def validate_attestation(criterion_id, decision, note):
    if not isinstance(criterion_id, str) or criterion_id not in {c["id"] for c in MANUAL}:
        raise ValueError("Choose a manual criterion.")
    if not isinstance(decision, str) or decision not in ("0", "1", "2", "3", "na"):
        raise ValueError("Choose a maturity level from 0 to 3, or na.")
    if not isinstance(note, str):
        raise ValueError("Evidence note must be text.")
    note = note.strip()
    if not note or len(note) > 2000:
        raise ValueError("Provide a short evidence or exclusion note (1 to 2000 characters).")
    return {"decision": decision, "note": note, "recorded_at": timestamp()}


def _finding(scope, status, detail, source="none", confidence="none",
             maturity=None, recorded_at=None):
    return {
        "scope": scope, "status": status, "detail": detail, "source": source,
        "confidence": confidence, "maturity": maturity, "recorded_at": recorded_at,
    }


def _summary(findings):
    counts = {status: sum(f["status"] == status for f in findings) for status in STATUSES}
    scores = [f["maturity"] for f in findings if f["status"] == "assessed"]
    return {
        "counts": counts,
        "assessed": len(scores),
        "applicable": len(findings) - counts["not_applicable"],
        "maturity": round(sum(scores) / len(scores), 2) if scores else None,
    }


def _validate_input(snapshot, attestations):
    if not isinstance(snapshot, dict) or snapshot.get("schema_version") != SNAPSHOT_VERSION:
        raise ValueError("Unsupported snapshot schema.")
    if snapshot.get("rubric_version") != RUBRIC_VERSION:
        raise ValueError("Snapshot rubric version does not match this assessment engine.")
    if snapshot.get("mode") not in ("demo", "live"):
        raise ValueError("Unsupported snapshot mode.")
    for field in ("enterprise", "host", "collected_at"):
        if not isinstance(snapshot.get(field), str) or not snapshot[field]:
            raise ValueError("Snapshot is missing valid " + field + " metadata.")
    if not isinstance(snapshot.get("organizations"), list) or not all(
            isinstance(org, str) for org in snapshot["organizations"]):
        raise ValueError("Snapshot organizations must be a list of names.")
    if not isinstance(snapshot.get("repositories"), list):
        raise ValueError("Snapshot repositories must be a list.")
    for repo in snapshot["repositories"]:
        if not isinstance(repo, dict) or not isinstance(repo.get("name"), str):
            raise ValueError("Snapshot contains an invalid repository record.")
        if not isinstance(repo.get("archived"), bool) or repo.get("status") not in (
                "collected", "inaccessible", "incomplete"):
            raise ValueError("Snapshot contains an invalid repository status.")
        if not isinstance(repo.get("settings"), dict) or not isinstance(repo.get("detail", ""), str):
            raise ValueError("Snapshot contains invalid repository evidence.")
    if not isinstance(snapshot.get("gaps", []), list):
        raise ValueError("Snapshot collection gaps must be a list.")
    for gap in snapshot.get("gaps", []):
        if (not isinstance(gap, dict) or not isinstance(gap.get("scope"), str) or
                not isinstance(gap.get("detail"), str) or gap.get("status") not in STATUSES):
            raise ValueError("Snapshot contains an invalid collection gap.")
    if not isinstance(attestations, dict):
        raise ValueError("Manual assessments must be a JSON object.")
    manual_ids = {c["id"] for c in MANUAL}
    for criterion_id, record in attestations.items():
        if criterion_id not in manual_ids or not isinstance(record, dict):
            raise ValueError("Manual assessment contains an unknown criterion.")
        validate_attestation(
            criterion_id, record.get("decision"), record.get("note")
        )
        if not isinstance(record.get("recorded_at"), str) or not record["recorded_at"]:
            raise ValueError("Manual assessment is missing its recorded time.")


def evaluate(snapshot, attestations):
    _validate_input(snapshot, attestations)
    criteria = []
    for criterion in RUBRIC:
        findings = []
        if criterion["field"]:
            for repo in snapshot["repositories"]:
                scope = repo["name"]
                if repo["archived"]:
                    findings.append(_finding(scope, "not_applicable", "Archived repository."))
                    continue
                if repo["status"] != "collected":
                    findings.append(_finding(scope, repo["status"], repo["detail"]))
                    continue
                value = repo["settings"].get(criterion["field"])
                if value not in ("enabled", "disabled"):
                    findings.append(_finding(
                        scope, "unknown", "Setting omitted or unrecognized; verify role and eligibility."
                    ))
                    continue
                source = "fixture" if snapshot["mode"] == "demo" else "api"
                findings.append(_finding(
                    scope, "assessed", "Configuration explicitly " + value + ".",
                    source, "high", 2 if value == "enabled" else 0, repo.get("observed_at"),
                ))
        else:
            response = attestations.get(criterion["id"])
            if not response:
                findings.append(_finding(
                    snapshot["enterprise"], "unknown", "Awaiting stakeholder evidence."
                ))
            else:
                decision = response["decision"]
                status = "not_applicable" if decision == "na" else "assessed"
                maturity = None if decision == "na" else int(decision)
                findings.append(_finding(
                    snapshot["enterprise"], status, response["note"],
                    "attestation", "medium", maturity, response["recorded_at"],
                ))
        summary = _summary(findings)
        criteria.append({
            **criterion, "summary": summary, "findings": findings,
            "has_gap": any(f["maturity"] in (0, 1) for f in findings),
        })

    pillars = []
    for key, title in PILLARS.items():
        members = [c for c in criteria if c["pillar"] == key]
        scores = [c["summary"]["maturity"] for c in members
                  if c["summary"]["maturity"] is not None]
        applicable = sum(bool(c["summary"]["applicable"]) for c in members)
        pillars.append({
            "id": key, "title": title, "assessed": len(scores),
            "applicable": applicable,
            "maturity": round(sum(scores) / len(scores), 2) if scores else None,
        })
    priority = {"High": 0, "Medium": 1}
    improvements = sorted(
        (c for c in criteria if c["has_gap"]), key=lambda c: priority[c["priority"]]
    )
    return {
        "schema_version": REPORT_VERSION,
        "rubric_version": RUBRIC_VERSION,
        "disclaimer": DISCLAIMER,
        "scale": LEVELS,
        "scope": {key: value for key, value in snapshot.items() if key != "repositories"},
        "collection_gaps": snapshot.get("gaps", []),
        "inventory": {
            "visible": len(snapshot["repositories"]),
            "active": sum(not repo["archived"] for repo in snapshot["repositories"]),
        },
        "pillars": pillars,
        "criteria": criteria,
        "improvements": [c["id"] for c in improvements],
    }
