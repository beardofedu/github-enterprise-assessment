# Implementing assessment findings

The assessment is deliberately read-only: it collects evidence and saves local questionnaire answers, but never changes GitHub enterprise, organization, or repository settings. Each **Implement** button downloads a Markdown task with the finding, suggested remediation, official references, and a completion checklist. Review the task with the appropriate owners before applying any setting or process change.

## Suggested workflow

1. Review the finding and its linked official guidance. A failed or partial result can affect only some organizations or repositories; confirm the scope before making changes.
2. Agree on the intended policy with enterprise, organization, security, and repository owners as appropriate. Consider exceptions, licensing, availability, and the impact on developers.
3. Apply the approved change through GitHub settings, a supported API, or your existing configuration-management process. Keep credentials and privileged changes in your organization's approved systems.
4. Verify the setting in GitHub and re-run collection. For process controls, record the evidence and answer the questionnaire.
5. Revisit the [official updates digest](official-updates.md) and source links before implementation; GitHub features and available settings change over time.

Unknown and unanswered items are coverage gaps, not confirmed configuration failures. Resolve missing access or evidence, or provide an assessor answer, before treating those items as changes to implement.

## Scope and trust

The downloaded task is a starting point, not an automatically executable configuration or a guarantee of compliance. The assessment does not have write permissions, and the generated plan must not be used to bypass your organization's review and change-control process.
