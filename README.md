# GitHub Enterprise Assessment

A local-first, read-only assessment tool for GitHub Enterprise Cloud. It combines a reusable Python scoring engine, command-line workflow, and localhost dashboard. The dashboard uses Primer CSS and semantic HTML; assessment data stays in a local data directory.

## Quick start

Requirements: Python 3.9+ and Node.js/npm for the locally served Primer CSS and accessibility test dependencies.

```sh
npm ci
python3 -m assessment demo
python3 -m assessment serve
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765). The demo uses clearly labeled fictional data. It makes no GitHub requests. Press Ctrl-C to stop the server. The server refuses to bind to a non-loopback address.

The default data directory is `~/.local/share/gh-enterprise-assessment/` with owner-only permissions. Set `GH_ASSESSMENT_HOME` or pass `--data-dir` to use another directory. Assessment evidence and exported reports can include sensitive organizational metadata; protect and delete them according to your organization's policies.

## Collect a real enterprise

Only collect from an enterprise you are authorized to assess. The enterprise slug must be explicitly supplied; the tool never discovers or scans an account on its own. The first release supports GitHub Enterprise Cloud at `github.com` only; it does not apply Cloud assumptions to GitHub Enterprise Server.

```sh
# Set GH_TOKEN securely in this shell using your approved local secret manager.
python3 -m assessment collect --enterprise YOUR_ENTERPRISE_SLUG
```

The collector needs a token that can access the GraphQL Enterprise Accounts API and read the selected organizations' repository metadata. For the enterprise organization connection, GitHub documents the classic token `read:enterprise` scope; access to organization/repository endpoints is independently permission-checked. Enterprise-installed GitHub Apps do not automatically receive organization or repository access. Missing or denied access is reported as an explicit collection gap; it is never converted into a disabled setting or a passing score. Tokens are read only from the process environment and are never saved in snapshots or reports.

Collection is limited to the organization roster and repository metadata needed for secret-scanning configuration. It does not retrieve source code, issues, pull request bodies, secrets, or alert contents. GitHub API pagination is followed via Link headers; rate limits and permission failures stop or mark collection as partial. Rerun after fixing access or waiting for the rate-limit reset.

## Assess and export

The rubric includes all five Well-Architected pillars. Practice-based questions are deliberately manual: API settings do not prove review quality, alert response, audit monitoring, or recovery effectiveness.

```sh
python3 -m assessment attest --criterion GOV-01 --level 2 \
  --note "Reviewed the retention policy and a recent alert exercise with the platform owner."
python3 -m assessment report --format json --output assessment.json
python3 -m assessment report --format html --output assessment.html
```

Use levels 0 (confirmed missing), 1 (ad hoc), 2 (established), and 3 (managed), or `na` with an evidence-backed rationale. Empty notes are rejected. Unknown, inaccessible, incomplete, and not-applicable results are separate from a confirmed level 0. Only findings with evidence are included in score denominators. Every criterion carries its rubric guidance link, evidence requirement, remediation, and priority rationale.

The maturity scale is project-defined, not an official GitHub scoring scale, certification, or guarantee. Automated findings score configuration only; manual attestations are labeled and assigned medium confidence. Results should be validated with stakeholder interviews and operational evidence.

## Rubric sources

The framework's [getting-started checklist](https://learn.github.com/well-architected/overview/getting-started-checklist) names the five pillars and describes an environment review with stakeholder interviews, analysis, and recommendation review. This first rubric version is a deliberately bounded sample, not the complete official checklist:

- [Productivity](https://learn.github.com/well-architected/productivity/checklist): repeatable CI feedback.
- [Collaboration](https://learn.github.com/well-architected/collaboration/checklist): code-review practices and onboarding.
- [Application Security](https://learn.github.com/well-architected/application-security/checklist): secret scanning, push protection, and response practices.
- [Governance](https://learn.github.com/well-architected/governance/checklist): audit monitoring and effective branch policy.
- [Architecture](https://learn.github.com/well-architected/architecture/checklist): recovery exercises.

Rubric version `1.0.0` and snapshot schema version `1` are recorded with the local evidence. Review the current framework links before relying on findings.

## Primer and accessibility

The dashboard uses locally installed Primer CSS (`@primer/css`), Primer component classes and color tokens, responsive layouts, visible keyboard focus, a skip link, semantic headings/landmarks, labeled controls, status announcements, reduced-motion handling, and no color-only status encoding. `npm run test:a11y` runs axe against the main dashboard in light and dark themes and after saving an attestation; it also checks the first keyboard stop and a narrow 390px viewport. This automation is a useful guardrail, not a substitute for human review with keyboard-only interaction, browser zoom, VoiceOver/Safari, and NVDA/Chrome.

## Tests

```sh
python3 -m unittest discover -s tests -v
npm run test:a11y
```

The test suite covers deterministic scoring, status/coverage semantics, version checks, API pagination and errors, manual evidence persistence, report escaping, and automated accessibility checks. The browser test requires Playwright's Chromium browser. If it is not installed yet, run `npx playwright install chromium`.
