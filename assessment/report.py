"""Portable, escaped HTML export."""

import html


def render_html(report):
    gaps = []
    for gap in report.get("collection_gaps", []):
        gaps.append(
            "<li><strong>" + html.escape(gap["scope"]) + ":</strong> " +
            html.escape(gap["status"]) + " — " + html.escape(gap["detail"]) + "</li>"
        )
    organizations = "".join(
        "<li>" + html.escape(org) + "</li>"
        for org in report["scope"].get("organizations", [])
    )
    rows = []
    for criterion in report["criteria"]:
        summary = criterion["summary"]
        score = "Not scored" if summary["maturity"] is None else (
            str(summary["maturity"]) + " / 3"
        )
        findings = []
        for item in criterion["findings"]:
            maturity = "" if item["maturity"] is None else " — level " + str(item["maturity"])
            findings.append(
                "<li><strong>" + html.escape(item["scope"]) + ":</strong> " +
                html.escape(item["status"]) + maturity + " — " + html.escape(item["detail"]) +
                " <span>(" + html.escape(item["source"]) + " evidence)</span></li>"
            )
        rows.append(
            "<section><h2>" + html.escape(criterion["title"]) + "</h2><p>" +
            html.escape(PILLAR_LABELS[criterion["pillar"]]) + " · " +
            html.escape(criterion["id"]) + " · " + score + " · " +
            str(summary["assessed"]) + " of " + str(summary["applicable"]) +
            " in scope assessed</p><p>" + html.escape(criterion["guidance"]) + "</p><ul>" +
            "".join(findings) + "</ul><p><strong>Suggested next step:</strong> " +
            html.escape(criterion["remediation"]) + "</p><p><a href=\"" +
            html.escape(criterion["source"], quote=True) + "\">Well-Architected guidance</a></p></section>"
        )
    scope = report["scope"]
    return """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GitHub Enterprise assessment — """ + html.escape(scope["enterprise"]) + """</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:70rem;margin:2rem auto;padding:0 1rem;color:#1f2328}
section{border:1px solid #d1d9e0;border-radius:8px;padding:1rem;margin:1rem 0}
a{color:#0969da} :focus-visible{outline:3px solid #0969da;outline-offset:3px}
.note{background:#ddf4ff;padding:1rem;border-radius:8px}
</style></head><body><main><h1>GitHub Enterprise assessment</h1>
<p>Enterprise: """ + html.escape(scope["enterprise"]) + """ · Host: """ + html.escape(scope["host"]) + """</p>
<p>Collected: """ + html.escape(scope["collected_at"]) + """ · Mode: """ + html.escape(scope["mode"]) + """</p>
<p class="note">""" + html.escape(report["disclaimer"]) + """ Evidence describes configuration or attestation, not operational effectiveness.</p>
<details><summary>Organizations in assessment scope</summary><ul>""" + organizations + """</ul></details>
<h2>Collection gaps</h2>""" + ("<ul>" + "".join(gaps) + "</ul>" if gaps else "<p>None reported.</p>") + """
<h2>Assessment evidence</h2>""" + "".join(rows) + """</main></body></html>"""


PILLAR_LABELS = {
    "productivity": "Productivity",
    "collaboration": "Collaboration",
    "application-security": "Application Security",
    "governance": "Governance",
    "architecture": "Architecture",
}
