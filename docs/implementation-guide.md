# Implementing assessment findings

Assessment collection, questionnaire answers, and dashboard actions are read-only with respect to GitHub settings. **Download task** exports a manual Markdown checklist; it never changes GitHub. All findings require a human to apply and verify approved changes through the organization's existing change-control process.

## Suggested workflow

1. Review the finding and its linked official guidance. A failed or partial result can affect only some organizations or repositories; confirm the scope before making changes.
2. Agree on the intended policy with enterprise, organization, security, and repository owners as appropriate. Consider exceptions, licensing, availability, and the impact on developers.
3. Apply the approved change through GitHub settings, a supported API, or your existing configuration-management process. The assessment credential is read-only and the dashboard does not perform writes.
4. Verify the setting in GitHub and re-run collection. For process controls, record the evidence and answer the questionnaire.
5. Revisit the [official updates digest](official-updates.md) and source links before implementation; GitHub features and available settings change over time.

Unknown and unanswered items are coverage gaps, not confirmed configuration failures. Resolve missing access or evidence, or provide an assessor answer, before treating those items as changes to implement.

## Scope and trust

The downloaded task is a starting point, not an automatically executable configuration or a guarantee of compliance. The generated plan must not be used to bypass your organization's review and change-control process.
