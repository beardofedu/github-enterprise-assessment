import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from pathlib import Path

from assessment.storage import demo_snapshot, write_json
from assessment.web import handler_for


class WebTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        write_json(Path(self.temp.name) / "snapshot.json", demo_snapshot())
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(self.temp.name))
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.base = "http://127.0.0.1:" + str(self.server.server_address[1])

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()
        self.temp.cleanup()

    def test_dashboard_and_json_api(self):
        with urlopen(self.base + "/") as response:
            self.assertIn(b"Skip to assessment", response.read())
            self.assertIn("default-src 'self'", response.headers["Content-Security-Policy"])
        with urlopen(self.base + "/api/report") as response:
            report = json.load(response)
        self.assertEqual(len(report["pillars"]), 5)

    def test_manual_attestation_persists_and_refreshes_scores(self):
        body = json.dumps({
            "criterion_id": "PROD-01",
            "decision": "2",
            "note": "Reviewed CI workflow samples and adoption data.",
        }).encode("utf-8")
        request = Request(self.base + "/api/attestations", data=body,
                          headers={"Content-Type": "application/json"}, method="POST")
        with urlopen(request) as response:
            report = json.load(response)
        finding = next(c for c in report["criteria"] if c["id"] == "PROD-01")["findings"][0]
        self.assertEqual(finding["maturity"], 2)
        with urlopen(self.base + "/api/report") as response:
            updated = json.load(response)
        self.assertEqual(next(c for c in updated["criteria"] if c["id"] == "PROD-01")
                         ["findings"][0]["source"], "attestation")

    def test_invalid_attestation_is_rejected(self):
        body = json.dumps({"criterion_id": "SEC-01", "decision": "3", "note": "not a manual control"}).encode("utf-8")
        request = Request(self.base + "/api/attestations", data=body,
                          headers={"Content-Type": "application/json"}, method="POST")
        with self.assertRaises(HTTPError) as caught:
            urlopen(request)
        self.assertEqual(caught.exception.code, 400)
        self.assertEqual(caught.exception.headers["X-Content-Type-Options"], "nosniff")

    def test_cross_origin_attestation_is_rejected(self):
        body = json.dumps({
            "criterion_id": "PROD-01", "decision": "2", "note": "evidence",
        }).encode("utf-8")
        request = Request(self.base + "/api/attestations", data=body, headers={
            "Content-Type": "application/json",
            "Origin": "http://attacker.example",
        }, method="POST")
        with self.assertRaises(HTTPError) as caught:
            urlopen(request)
        self.assertEqual(caught.exception.code, 403)


if __name__ == "__main__":
    unittest.main()
