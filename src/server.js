import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { assess, normalizeAnswer } from './engine.js';
import { renderHtml, renderMarkdown } from './report.js';
import { readPrimerCss } from './web-assets.js';

const TEMPLATE_URL = new URL('./web/index.html', import.meta.url);
const MAX_BODY = 64 * 1024;

export function loadAnswers(path) {
  if (!path || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function saveAnswers(path, answers) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(answers, null, 2)}\n`);
  renameSync(tmp, path);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createServer({ rubric, evidence, answersPath, port }) {
  const primerCss = readPrimerCss();
  let answers = loadAnswers(answersPath);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const current = () => assess({ rubric, evidence, answers });
  const send = (res, status, body, type) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  };

  return http.createServer(async (req, res) => {
    // Rejecting unexpected Host headers blocks DNS-rebinding access to local assessment data.
    if (!allowedHosts.has(req.headers.host)) return send(res, 403, 'Forbidden host', 'text/plain');
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, readFileSync(TEMPLATE_URL, 'utf8'), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/primer.css') return send(res, 200, primerCss, 'text/css; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/assessment') return send(res, 200, JSON.stringify(current()), 'application/json');
      if (req.method === 'GET' && url.pathname === '/api/report.md') return send(res, 200, renderMarkdown(current()), 'text/markdown; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/report.html') return send(res, 200, renderHtml(current(), primerCss), 'text/html; charset=utf-8');
      if (req.method === 'POST' && url.pathname === '/api/answers/import') {
        if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, 'Expected application/json', 'text/plain');
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
          return send(res, 400, 'Invalid JSON answers file', 'text/plain');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length) {
          return send(res, 400, 'Expected a non-empty object keyed by control id', 'text/plain');
        }
        const imported = {};
        for (const [id, raw] of Object.entries(body)) {
          const control = rubric.controls.find((c) => c.id === id);
          const validShape = typeof raw === 'string' || (raw && typeof raw === 'object' && !Array.isArray(raw)
            && typeof raw.answer === 'string' && (raw.notes === undefined || typeof raw.notes === 'string'));
          const normalized = validShape ? normalizeAnswer(raw) : null;
          if (!control || !normalized || typeof normalized.notes !== 'string' || normalized.notes.length > 4000) {
            return send(res, 400, `Invalid control, answer, or notes for ${id}`, 'text/plain');
          }
          imported[id] = normalized;
        }
        const next = { ...answers, ...imported };
        if (answersPath) saveAnswers(answersPath, next);
        answers = next;
        return send(res, 200, JSON.stringify(current()), 'application/json');
      }
      if (req.method === 'POST' && url.pathname === '/api/answers') {
        // Requiring a JSON content type forces a CORS preflight, so other sites cannot post answers.
        if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, 'Expected application/json', 'text/plain');
        const body = JSON.parse(await readBody(req));
        const control = rubric.controls.find((c) => c.id === body.id);
        const normalized = normalizeAnswer({ answer: body.answer, notes: String(body.notes || '').slice(0, 4000) });
        if (!control || !normalized) return send(res, 400, 'Invalid control id or answer', 'text/plain');
        answers = { ...answers, [control.id]: normalized };
        if (answersPath) saveAnswers(answersPath, answers);
        return send(res, 200, JSON.stringify(current()), 'application/json');
      }
      return send(res, 404, 'Not found', 'text/plain');
    } catch (err) {
      return send(res, 500, `Error: ${err.message}`, 'text/plain');
    }
  });
}
