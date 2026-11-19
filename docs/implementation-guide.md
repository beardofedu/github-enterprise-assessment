# Implementing assessment findings

Assessment collection and questionnaire answers remain read-only with respect to GitHub settings. **Download task** exports a manual Markdown checklist; it never changes GitHub. A separate **Apply supported setting** action is available only for GOV-05 and GOV-06 organization findings, and requires a separately supplied implementation token and explicit approval for each change. Other controls remain manual.

## Suggested workflow

1. Review the finding and its linked official guidance. A failed or partial result can affect only some organizations or repositories; confirm the scope before making changes.
2. Agree on the intended policy with enterprise, organization, security, and repository owners as appropriate. Consider exceptions, licensing, availability, and the impact on developers.
3. For GOV-05 or GOV-06, verify the target organization and requested setting in the confirmation dialog, then provide an organization-authorized fine-grained implementation token. The assessment credential is never used for writes. For all other controls, apply the approved change through GitHub settings, a supported API, or your existing configuration-management process.
4. Verify the setting in GitHub and re-run collection. For process controls, record the evidence and answer the questionnaire.
5. Revisit the [official updates digest](official-updates.md) and source links before implementation; GitHub features and available settings change over time.

Unknown and unanswered items are coverage gaps, not confirmed configuration failures. Resolve missing access or evidence, or provide an assessor answer, before treating those items as changes to implement.

## Scope and trust

The downloaded task is a starting point, not an automatically executable configuration or a guarantee of compliance. Automated setting changes are limited to the two listed organization settings and are made only with the separately supplied token after confirmation. The generated plan must not be used to bypass your organization's review and change-control process.
