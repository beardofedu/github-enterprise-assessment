import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from assessment.cli import main
from assessment.storage import demo_snapshot, write_json


class CliTests(unittest.TestCase):
    def test_demo_assessment_and_html_export(self):
        with tempfile.TemporaryDirectory() as root:
            data_dir = Path(root) / "data"
            report_path = Path(root) / "assessment.html"
            with patch("builtins.print"):
                self.assertEqual(main(["demo", "--data-dir", str(data_dir)]), 0)
                self.assertEqual(main([
                    "attest", "--criterion", "PROD-01", "--level", "2",
                    "--note", "Reviewed evidence.", "--data-dir", str(data_dir),
                ]), 0)
                self.assertEqual(main([
                    "report", "--format", "html", "--output", str(report_path),
                    "--data-dir", str(data_dir),
                ]), 0)
            content = report_path.read_text(encoding="utf-8")
            self.assertIn("GitHub Enterprise assessment", content)
            self.assertIn("Reviewed evidence.", content)
            self.assertEqual(report_path.stat().st_mode & 0o777, 0o600)

    def test_collect_requires_explicit_enterprise_and_reports_missing_scope(self):
        with patch("builtins.print"), patch.dict("os.environ", {"GH_TOKEN": "", "GITHUB_TOKEN": ""}):
            self.assertEqual(main(["collect", "--enterprise", "example"]), 2)


if __name__ == "__main__":
    unittest.main()
