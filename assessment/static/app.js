"use strict";

(() => {
  const root = document.getElementById("criteria");
  const statusBox = document.getElementById("status");
  let reportData;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function append(parent, tag, className, text) {
    const element = node(tag, className, text);
    parent.append(element);
    return element;
  }

  function setStatus(message, kind) {
    statusBox.className = "flash mb-4 " + (kind || "flash-info");
    statusBox.textContent = message;
  }

  function showScope(report) {
    const scope = report.scope;
    document.getElementById("enterprise").textContent = scope.enterprise;
    document.getElementById("collection").textContent =
      scope.collection_status + " · " + scope.mode + " · " + scope.collected_at;
    document.getElementById("organizations").textContent =
      (scope.organizations || []).length + " in selected scope";
    const organizations = document.getElementById("organization-list");
    organizations.replaceChildren();
    for (const login of scope.organizations || []) append(organizations, "li", "", login);
    document.getElementById("repositories").textContent =
      report.inventory.active + " active · " + report.inventory.visible + " visible";
    document.getElementById("gaps").textContent = (scope.gaps || []).length;
    document.getElementById("rubric").textContent = report.rubric_version;
    document.getElementById("scope-label").textContent =
      scope.host + " · " + (scope.mode === "demo" ? "fictional fixture" : "read-only snapshot");
    const gapSection = document.getElementById("gaps-section");
    const gapList = document.getElementById("gap-list");
    gapList.replaceChildren();
    for (const gap of report.collection_gaps || []) {
      append(gapList, "li", "", gap.scope + " · " + gap.status + " — " + gap.detail);
    }
    gapSection.hidden = !(report.collection_gaps || []).length;
    if (scope.mode === "demo") {
      setStatus("Demo fixture only — no GitHub connection was made.", "flash-warn");
    } else if (scope.collection_status !== "complete") {
      setStatus(
        "Collection is partial. " + (scope.gaps || []).length +
          " gap(s) are visible below and are not scored as healthy or missing.",
        "flash-warn"
      );
    } else {
      setStatus("Assessment evidence loaded locally.", "flash-success");
    }
  }

  function showPillars(report) {
    const container = document.getElementById("pillars");
    container.replaceChildren();
    for (const pillar of report.pillars) {
      const card = append(container, "article", "Box p-3 pillar-card");
      append(card, "h3", "h4", pillar.title);
      append(card, "p", "h1 mb-1", pillar.maturity === null ? "—" : pillar.maturity + " / 3");
      append(card, "p", "color-fg-muted mb-0",
        pillar.assessed + " of " + pillar.applicable + " applicable criteria with scores");
    }
  }

  function levelLabel(report, value) {
    if (value === null || value === undefined) return "Not scored";
    return value + " · " + report.scale[String(value)];
  }

  function showFindingList(card, criterion) {
    if (!criterion.findings.length) return;
    const list = append(card, "ul", "finding-list");
    for (const finding of criterion.findings) {
      const item = append(list, "li", "", "");
      const label = append(item, "span", "text-bold", finding.scope + ": ");
      label.append(document.createTextNode(finding.status + " — "));
      item.append(document.createTextNode(finding.detail));
      if (finding.maturity !== null) {
        item.append(document.createTextNode(" · " + levelLabel(reportData, finding.maturity)));
      }
      if (finding.confidence !== "none") {
        item.append(document.createTextNode(" · " + finding.source + " evidence, " +
          finding.confidence + " confidence"));
      }
    }
  }

  function addManualForm(card, criterion) {
    const prior = criterion.findings.find((finding) => finding.source === "attestation");
    const form = append(card, "form", "manual-form");
    form.dataset.criterionId = criterion.id;
    const levelLabelElement = append(form, "label", "", "Maturity level");
    const select = append(levelLabelElement, "select", "form-select");
    select.name = "decision";
    select.required = true;
    const choices = [
      ["", "Choose a level"],
      ["0", "0 — Missing (confirmed absent)"],
      ["1", "1 — Ad hoc"],
      ["2", "2 — Established"],
      ["3", "3 — Managed"],
      ["na", "Not applicable"],
    ];
    for (const [value, label] of choices) {
      const option = append(select, "option", "", label);
      option.value = value;
      if (prior && String(prior.maturity) === value) option.selected = true;
      if (prior && prior.status === "not_applicable" && value === "na") option.selected = true;
    }
    const noteLabel = append(form, "label", "", "Evidence or reason for exclusion");
    const textarea = append(noteLabel, "textarea", "form-control");
    textarea.name = "note";
    textarea.rows = 3;
    textarea.maxLength = 2000;
    textarea.required = true;
    textarea.placeholder = "Summarize evidence and its source; do not include secrets.";
    if (prior) textarea.value = prior.detail;
    append(form, "p", "note color-fg-muted mb-0",
      "Manual attestation · medium confidence · save only a brief evidence summary, never secrets.");
    const submit = append(form, "button", "btn btn-primary", "Save assessment");
    submit.type = "submit";
    form.addEventListener("submit", saveAttestation);
  }

  function showCriteria(report) {
    reportData = report;
    root.replaceChildren();
    for (const criterion of report.criteria) {
      const card = append(root, "article", "Box p-3 criterion-card");
      card.dataset.pillar = criterion.pillar;
      const heading = append(card, "div", "criterion-heading");
      append(heading, "h3", "h3", criterion.title);
      append(heading, "span", "Label", criterion.id);
      const meta = append(card, "p", "criterion-meta");
      meta.append(document.createTextNode(
        criterion.priority + " priority · " + criterion.summary.assessed + " of " +
          criterion.summary.applicable + " applicable findings scored · " +
          levelLabel(report, criterion.summary.maturity)
      ));
      append(card, "p", "", criterion.guidance);
      const details = append(card, "details", "mb-3");
      append(details, "summary", "text-bold", "Evidence requirements and results");
      append(details, "p", "", criterion.evidence);
      showFindingList(details, criterion);
      append(card, "p", "", criterion.remediation);
      const source = append(card, "a", "Link", "Well-Architected source");
      source.href = criterion.source;
      source.rel = "noreferrer";
      if (criterion.field) {
        append(card, "p", "color-fg-muted text-small mb-0",
          "Configuration evidence does not establish process effectiveness.");
      } else {
        addManualForm(card, criterion);
      }
    }
    filterCriteria();
  }

  async function saveAttestation(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    setStatus("Saving evidence locally…", "flash-info");
    try {
      const response = await fetch("/api/attestations", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          criterion_id: form.dataset.criterionId,
          decision: form.elements.decision.value,
          note: form.elements.note.value,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save evidence.");
      showCriteria(result);
      showPillars(result);
      setStatus("Evidence saved locally. The report now reflects the updated assessment.", "flash-success");
    } catch (error) {
      setStatus(error.message, "flash-error");
    } finally {
      const current = root.querySelector(
        'form[data-criterion-id="' + CSS.escape(form.dataset.criterionId) + '"] button[type=submit]'
      );
      if (current) current.disabled = false;
    }
  }

  function filterCriteria() {
    const pillar = document.getElementById("pillar-filter").value;
    for (const card of root.querySelectorAll(".criterion-card")) {
      card.hidden = Boolean(pillar && card.dataset.pillar !== pillar);
    }
  }

  async function load() {
    try {
      const response = await fetch("/api/report", {headers: {"Accept": "application/json"}});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load assessment.");
      showScope(result);
      showPillars(result);
      showCriteria(result);
    } catch (error) {
      setStatus(error.message + " Run `python -m assessment demo` or `collect` first.", "flash-error");
    }
  }

  document.getElementById("pillar-filter").addEventListener("change", filterCriteria);
  load();
})();
