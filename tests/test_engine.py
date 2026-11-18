import unittest

from assessment.engine import (
    AUTO, MANUAL, RUBRIC_VERSION, SNAPSHOT_VERSION, evaluate, validate_attestation,
)
from assessment.report import render_html
from assessment.storage import demo_snapshot


class EngineTests(unittest.TestCase):
    def test_demo_covers_all_five_pillars_and_preserves_unknowns(self):
        snapshot = demo_snapshot()
        report = evaluate(snapshot, {})
        self.assertEqual(len(report["pillars"]), 5)
        self.assertEqual(len(report["criteria"]), len(AUTO) + len(MANUAL))
        secret_scanning = next(c for c in report["criteria"] if c["id"] == "SEC-01")
        self.assertEqual(secret_scanning["summary"]["counts"]["inaccessible"], 1)
        self.assertEqual(secret_scanning["summary"]["counts"]["not_applicable"], 1)
        self.assertEqual(secret_scanning["summary"]["assessed"], 3)
        self.assertEqual(secret_scanning["summary"]["applicable"], 4)

    def test_unknown_and_inaccessible_findings_are_not_scored_as_absent(self):
        snapshot = demo_snapshot()
        snapshot["repositories"] = [
            {"name": "o/unknown", "archived": False, "status": "collected",
             "settings": {}, "detail": "", "observed_at": None},
            {"name": "o/private", "archived": False, "status": "inaccessible",
             "settings": {}, "detail": "forbidden", "observed_at": None},
            {"name": "o/disabled", "archived": False, "status": "collected",
             "settings": {"secret_scanning": "disabled"}, "detail": "", "observed_at": None},
        ]
        criterion = next(c for c in evaluate(snapshot, {})["criteria"] if c["id"] == "SEC-01")
        self.assertEqual(criterion["summary"]["counts"]["unknown"], 1)
        self.assertEqual(criterion["summary"]["counts"]["inaccessible"], 1)
        self.assertEqual(criterion["summary"]["maturity"], 0)
        self.assertEqual(criterion["summary"]["assessed"], 1)
        self.assertEqual(criterion["summary"]["applicable"], 3)

    def test_manual_attestation_is_validated_and_scored_separately(self):
        self.assertEqual(len(MANUAL), 6)
        criterion = MANUAL[0]
        with self.assertRaises(ValueError):
            validate_attestation("SEC-01", "0", "looks good")
        with self.assertRaises(ValueError):
            validate_attestation(criterion["id"], "0", " ")
        record = validate_attestation(criterion["id"], "2", "Reviewed evidence with platform owners.")
        result = evaluate(demo_snapshot(), {criterion["id"]: record})
        finding = next(c for c in result["criteria"] if c["id"] == criterion["id"])["findings"][0]
        self.assertEqual((finding["status"], finding["source"], finding["confidence"], finding["maturity"]),
                         ("assessed", "attestation", "medium", 2))

    def test_snapshot_schema_is_checked(self):
        snapshot = demo_snapshot()
        snapshot["schema_version"] = SNAPSHOT_VERSION + 1
        with self.assertRaisesRegex(ValueError, "schema"):
            evaluate(snapshot, {})
        snapshot = demo_snapshot()
        snapshot["rubric_version"] = "0.0.1"
        with self.assertRaisesRegex(ValueError, "rubric"):
            evaluate(snapshot, {})

    def test_invalid_local_evidence_is_rejected(self):
        snapshot = demo_snapshot()
        snapshot["repositories"][0]["status"] = "passed"
        with self.assertRaisesRegex(ValueError, "repository status"):
            evaluate(snapshot, {})
        snapshot = demo_snapshot()
        with self.assertRaisesRegex(ValueError, "maturity"):
            evaluate(snapshot, {"PROD-01": {"decision": "5", "note": "evidence", "recorded_at": "now"}})

    def test_html_report_escapes_scope_and_evidence(self):
        snapshot = demo_snapshot()
        snapshot["enterprise"] = "<img src=x onerror=alert(1)>"
        report = evaluate(snapshot, {})
        html = render_html(report)
        self.assertNotIn("<img src=x", html)
        self.assertIn("&lt;img", html)


if __name__ == "__main__":
    unittest.main()
