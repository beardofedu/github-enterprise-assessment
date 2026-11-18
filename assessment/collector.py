"""Read-only, bounded GitHub Enterprise Cloud evidence collection."""

import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urljoin, urlparse
from urllib.request import Request, urlopen

from .engine import RUBRIC_VERSION, SNAPSHOT_VERSION, timestamp

API_ROOT = "https://api.github.com"
API_VERSION = "2026-03-10"
ENTERPRISE_QUERY = """
query AssessmentOrganizations($slug: String!, $after: String) {
  enterprise(slug: $slug) {
    organizations(first: 100, after: $after) {
      nodes { login }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"""


class GitHubAPIError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def _safe_api_url(url):
    parsed = urlparse(url)
    if (parsed.scheme != "https" or parsed.hostname != "api.github.com" or
            parsed.username or parsed.password or parsed.port not in (None, 443)):
        raise ValueError("This collector currently supports GitHub Enterprise Cloud at api.github.com only.")


def _request(url, token, method="GET", body=None, opener=urlopen):
    _safe_api_url(url)
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + token,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "github-enterprise-assessment",
    }
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    request = Request(url, data=data, headers=headers, method=method)
    try:
        response = opener(request, timeout=30)
        with response:
            payload = json.loads(response.read().decode("utf-8"))
            return payload, response.headers
    except HTTPError as error:
        status = error.code
        if status == 403 and (error.headers or {}).get("X-RateLimit-Remaining") == "0":
            reset = error.headers.get("X-RateLimit-Reset", "unknown")
            raise GitHubAPIError(status, "GitHub API rate limit reached; reset epoch " + reset)
        raise GitHubAPIError(status, "GitHub API returned HTTP " + str(status)) from None
    except (URLError, TimeoutError, ValueError, UnicodeDecodeError) as error:
        raise GitHubAPIError(0, "GitHub API request failed (" + type(error).__name__ + ").") from None


def _pages(url, token, opener=urlopen):
    while url:
        payload, headers = _request(url, token, opener=opener)
        if not isinstance(payload, list):
            raise GitHubAPIError(0, "GitHub API returned an unexpected page shape.")
        for item in payload:
            yield item
        links = headers.get("Link", "")
        next_url = None
        for part in links.split(","):
            match = re.match(r'\s*<([^>]+)>;\s*rel="([^"]+)"', part)
            if match and match.group(2) == "next":
                next_url = urljoin(url, match.group(1))
                _safe_api_url(next_url)
                break
        url = next_url


def collect_enterprise(enterprise, token=None, opener=urlopen):
    if not re.fullmatch(r"[A-Za-z0-9-]{1,39}", enterprise):
        raise ValueError("Enterprise must be a GitHub Enterprise Cloud slug.")
    token = token or os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        raise ValueError("Set GH_TOKEN or GITHUB_TOKEN with read:enterprise access. Token is not stored.")
    organizations = []
    cursor = None
    while True:
        query_url = API_ROOT + "/graphql"
        result, _ = _request(query_url, token, "POST", {
            "query": ENTERPRISE_QUERY,
            "variables": {"slug": enterprise, "after": cursor},
        }, opener=opener)
        if result.get("errors"):
            raise GitHubAPIError(0, "Enterprise organization query failed; check enterprise access and read:enterprise scope.")
        account = result.get("data", {}).get("enterprise")
        if account is None:
            raise GitHubAPIError(404, "Enterprise was not found or is not visible to this token.")
        connection = account.get("organizations") or {}
        organizations.extend(org["login"] for org in connection.get("nodes", []) if org.get("login"))
        page = connection.get("pageInfo", {})
        if not page.get("hasNextPage"):
            break
        cursor = page.get("endCursor")
        if not cursor:
            raise GitHubAPIError(0, "Enterprise organization pagination returned no cursor.")

    repositories, gaps = [], []
    for organization in organizations:
        rate_limited = False
        repos_url = (
            API_ROOT + "/orgs/" + quote(organization, safe="") +
            "/repos?type=all&per_page=100&page=1"
        )
        try:
            for listing in _pages(repos_url, token, opener=opener):
                repo_name = listing.get("full_name") or organization + "/" + listing.get("name", "unknown")
                repo_url = API_ROOT + "/repos/" + quote(repo_name, safe="/")
                try:
                    repo, _ = _request(repo_url, token, opener=opener)
                    features = repo.get("security_and_analysis") or {}
                    settings = {}
                    for feature in ("secret_scanning", "secret_scanning_push_protection"):
                        value = (features.get(feature) or {}).get("status")
                        if value in ("enabled", "disabled"):
                            settings[feature] = value
                    repositories.append({
                        "name": repo_name, "archived": bool(repo.get("archived")),
                        "status": "collected", "detail": "", "settings": settings,
                        "observed_at": timestamp(),
                    })
                except GitHubAPIError as error:
                    status = "inaccessible" if error.status in (403, 404) else "incomplete"
                    repositories.append({
                        "name": repo_name, "archived": bool(listing.get("archived")),
                        "status": status, "detail": str(error), "settings": {},
                        "observed_at": timestamp(),
                    })
                    gaps.append({"scope": repo_name, "status": status, "detail": str(error)})
                    if error_is_rate_limited(error):
                        rate_limited = True
                        break
            if rate_limited:
                gaps.append({
                    "scope": enterprise,
                    "status": "incomplete",
                    "detail": "Collection stopped at the GitHub API rate limit; rerun after reset.",
                })
                break
        except GitHubAPIError as error:
            status = "inaccessible" if error.status in (403, 404) else "incomplete"
            gaps.append({"scope": organization, "status": status, "detail": str(error)})
            if error_is_rate_limited(error):
                gaps.append({
                    "scope": enterprise,
                    "status": "incomplete",
                    "detail": "Collection stopped at the GitHub API rate limit; rerun after reset.",
                })
                break

    return {
        "schema_version": SNAPSHOT_VERSION,
        "rubric_version": RUBRIC_VERSION,
        "mode": "live",
        "host": "github.com",
        "enterprise": enterprise,
        "collected_at": timestamp(),
        "collection_status": "partial" if gaps else "complete",
        "organizations": organizations,
        "repositories": repositories,
        "gaps": gaps,
    }


def error_is_rate_limited(gap):
    return bool(gap and "rate limit" in str(gap).lower())
