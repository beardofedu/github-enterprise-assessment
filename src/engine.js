import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checks as builtInChecks } from './checks.js';

export const DEFAULT_RUBRIC_PATH = fileURLToPath(new URL('../rubric/well-architected.json', import.meta.url));
const ANSWERS = new Set(['yes', 'partial', 'no', 'na']);
const SEVERITY = { 3: 'High', 2: 'Medium', 1: 'Low' };

export function loadRubric(path = DEFAULT_RUBRIC_PATH, checks = builtInChecks) {
  const rubric = JSON.parse(readFileSync(path, 'utf8'));
  validateRubric(rubric, checks);
  return rubric;
}

export function validateRubric(rubric, checks = builtInChecks) {
  const pillarIds = new Set(rubric.pillars.map((p) => p.id));
  const seen = new Set();
  for (const c of rubric.controls) {
    if (seen.has(c.id)) throw new Error(`Duplicate control id ${c.id}`);
    seen.add(c.id);
    if (!pillarIds.has(c.pillar)) throw new Error(`Control ${c.id} references unknown pillar '${c.pillar}'`);
    if (!(c.weight > 0)) throw new Error(`Control ${c.id} must have a positive weight`);
    if (c.type === 'automated' && !checks[c.id]) throw new Error(`Automated control ${c.id} has no check implementation`);
    if (c.type === 'manual' && !c.question) throw new Error(`Manual control ${c.id} needs a question`);
    if (!['automated', 'manual'].includes(c.type)) throw new Error(`Control ${c.id} has invalid type '${c.type}'`);
  }
}

export function normalizeAnswer(raw) {
  if (raw == null) return null;
  const obj = typeof raw === 'string' ? { answer: raw } : raw;
  const answer = String(obj.answer || '').toLowerCase();
  if (!ANSWERS.has(answer)) return null;
  return { answer, notes: obj.notes || '' };
}

export function maturityFor(score, rubric) {
  if (score == null) return null;
  const levels = [...rubric.scoring.maturityLevels].sort((a, b) => b.min - a.min);
  return levels.find((l) => score >= l.min) || levels[levels.length - 1];
}

function weightedScore(controls) {
  const scored = controls.filter((c) => c.score != null);
  const weight = scored.reduce((s, c) => s + c.weight, 0);
  if (!weight) return null;
  return Math.round((scored.reduce((s, c) => s + c.score * c.weight, 0) / weight) * 1000) / 10;
}

function evaluateControl(control, evidence, answers, rubric, checks) {
  const answer = normalizeAnswer(answers[control.id]);
  const fromAnswer = (source) => {
    if (answer.answer === 'na') return { status: 'not_applicable', score: null, finding: 'Marked not applicable by the assessor.', source };
    const status = answer.answer === 'yes' ? 'pass' : answer.answer === 'no' ? 'fail' : 'partial';
    return { status, score: rubric.scoring.answerScores[answer.answer], finding: `Assessor answered '${answer.answer}'.`, source };
  };

  if (control.type === 'manual') {
    if (!answer) return { status: 'unanswered', score: null, finding: 'Awaiting assessor answer.', source: 'manual' };
    return fromAnswer('manual');
  }

  let r;
  try {
    r = checks[control.id](evidence);
  } catch (err) {
    r = { status: 'unknown', finding: `Check failed: ${err.message}`, details: {} };
  }
  // Assessors can supply an answer for an automated control the token could not evaluate.
  if (r.status === 'unknown' && answer) return { ...fromAnswer('manual-override'), details: r.details, automatedFinding: r.finding };
  const score = r.status in rubric.scoring.statusScores ? rubric.scoring.statusScores[r.status] : null;
  return { status: r.status, score, finding: r.finding, details: r.details, source: 'automated' };
}

export function assess({ rubric, evidence, answers = {}, checks = builtInChecks }) {
  const controls = rubric.controls.map((control) => {
    const evaluated = evaluateControl(control, evidence, answers, rubric, checks);
    const notes = normalizeAnswer(answers[control.id])?.notes || '';
    return { ...control, ...evaluated, notes, severity: SEVERITY[control.weight] || 'Low' };
  });

  const pillars = rubric.pillars.map((p) => {
    const pcs = controls.filter((c) => c.pillar === p.id);
    const score = weightedScore(pcs);
    const counts = {};
    for (const c of pcs) counts[c.status] = (counts[c.status] || 0) + 1;
    const applicable = pcs.filter((c) => c.status !== 'not_applicable');
    const assessed = applicable.filter((c) => c.score != null);
    return {
      ...p,
      score,
      maturity: maturityFor(score, rubric),
      counts,
      controlCount: pcs.length,
      coverage: applicable.length ? Math.round((assessed.length / applicable.length) * 100) : 100,
    };
  });

  const overallScore = weightedScore(controls);
  const applicable = controls.filter((c) => c.status !== 'not_applicable');
  const assessed = applicable.filter((c) => c.score != null);

  const improvements = controls
    .filter((c) => c.score != null && c.score < 1)
    .map((c) => ({ id: c.id, pillar: c.pillar, area: c.area, title: c.title, status: c.status, severity: c.severity, priority: Math.round(c.weight * (1 - c.score) * 100) / 100, finding: c.finding, remediation: c.remediation, references: c.references }))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  const coverageGaps = controls
    .filter((c) => c.status === 'unknown' || c.status === 'unanswered')
    .map((c) => ({ id: c.id, pillar: c.pillar, title: c.title, status: c.status, finding: c.finding, question: c.question || null }));

  return {
    meta: {
      rubric: { id: rubric.id, version: rubric.version, title: rubric.title, source: rubric.source },
      assessedAt: new Date().toISOString(),
      evidenceGeneratedAt: evidence.meta?.generatedAt || null,
      enterprise: evidence.meta?.enterprise || null,
      organizations: evidence.meta?.organizations || Object.keys(evidence.orgs || {}),
      apiUrl: evidence.meta?.apiUrl || null,
    },
    overall: {
      score: overallScore,
      maturity: maturityFor(overallScore, rubric),
      coverage: applicable.length ? Math.round((assessed.length / applicable.length) * 100) : 100,
      assessedControls: assessed.length,
      applicableControls: applicable.length,
    },
    pillars,
    controls,
    improvements,
    coverageGaps,
  };
}
