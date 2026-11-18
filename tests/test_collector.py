import json
import os
import unittest
from email.message import Message
from unittest.mock import patch
from urllib.error import HTTPError

from assessment.collector import (
    GitHubAPIError, _pages, collect_enterprise,
)


class Response:
    def __init__(self, value, headers=None):
        self.value = value
        self.headers = headers or Message()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return json.dumps(self.value).encode("utf-8")


class CollectorTests(unittest.TestCase):
    def test_pages_follow_link_header_until_last_page(self):
        calls = []

        def opener(request, timeout=30):
            calls.append(request.full_url)
            headers = Message()
            if len(calls) == 1:
                headers["Link"] = '<https://api.github.com/orgs/o/repos?page=2>; rel="next"'
                return Response([{"name": "first"}], headers)
            return Response([{"name": "second"}], headers)

        records = list(_pages("https://api.github.com/orgs/o/repos?page=1", "secret", opener))
        self.assertEqual([r["name"] for r in records], ["first", "second"])
        self.assertEqual(len(calls), 2)

    def test_pagination_refuses_external_link(self):
        def opener(request, timeout=30):
            headers = Message()
            headers["Link"] = '<https://attacker.example/page2>; rel="next"'
            return Response([{"name": "first"}], headers)

        with self.assertRaises(ValueError):
            list(_pages("https://api.github.com/orgs/o/repos", "secret", opener))

    def test_collect_is_paginated_and_reads_only_repo_metadata(self):
        calls = []

        def opener(request, timeout=30):
            calls.append((request.method, request.full_url))
            if request.full_url.endswith("/graphql"):
                page = json.loads(request.data.decode("utf-8"))["variables"]["after"]
                if page is None:
                    return Response({"data": {"enterprise": {"organizations": {
                        "nodes": [{"login": "one"}],
                        "pageInfo": {"hasNextPage": True, "endCursor": "cursor-1"},
                    }}}})
                return Response({"data": {"enterprise": {"organizations": {
                    "nodes": [{"login": "two"}],
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                }}}})
            if "/orgs/" in request.full_url:
                org = "one" if "/one/" in request.full_url else "two"
                return Response([{"full_name": org + "/repo", "archived": False}])
            org = "one" if "/one/" in request.full_url else "two"
            return Response({
                "full_name": org + "/repo",
                "archived": False,
                "security_and_analysis": {
                    "secret_scanning": {"status": "enabled"},
                    "secret_scanning_push_protection": {"status": "disabled"},
                },
            })

        result = collect_enterprise("example", token="not-saved", opener=opener)
        self.assertEqual(result["organizations"], ["one", "two"])
        self.assertEqual(len(result["repositories"]), 2)
        self.assertEqual(result["repositories"][0]["settings"]["secret_scanning"], "enabled")
        self.assertNotIn("not-saved", json.dumps(result))
        self.assertTrue(all("/contents/" not in url for _, url in calls))

    def test_enterprise_query_failure_does_not_claim_missing_settings(self):
        def opener(request, timeout=30):
            headers = Message()
            headers["X-RateLimit-Remaining"] = "0"
            raise HTTPError(request.full_url, 403, "forbidden", headers, None)

        with self.assertRaises(GitHubAPIError) as caught:
            collect_enterprise("example", token="sensitive-token", opener=opener)
        self.assertIn("rate limit", str(caught.exception))
        self.assertNotIn("sensitive-token", str(caught.exception))

    def test_missing_token_and_unsupported_host_are_explicit(self):
        with patch.dict(os.environ, {"GH_TOKEN": "", "GITHUB_TOKEN": ""}):
            with self.assertRaisesRegex(ValueError, "GH_TOKEN"):
                collect_enterprise("example", token="")


if __name__ == "__main__":
    unittest.main()
