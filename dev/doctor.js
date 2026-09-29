#!/usr/bin/env node
'use strict';
const { createSystem } = require('./doctor/system');
const { gather } = require('./doctor/context');
const { runChecks } = require('./doctor/checks');

const EXIT_CODES = { ok: 0, warn: 1, fail: 2 };
const LABELS = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL' };

function overallStatus(results) {
  if (results.some(r => r.status === 'fail')) return 'fail';
  if (results.some(r => r.status === 'warn')) return 'warn';
  return 'ok';
}

function verdictLine(results, ctx) {
  const failures = results.filter(r => r.status === 'fail').length;
  const warnings = results.filter(r => r.status === 'warn').length;
  const status = overallStatus(results);
  const headline = status === 'ok' ? 'HEALTHY' : status === 'warn' ? 'DEGRADED' : 'BROKEN';
  return `claude-wow doctor: ${headline}, ${failures} failure(s), ${warnings} warning(s), ${results.length} checks (checkout ${ctx.checkout || 'unknown'}, home ${ctx.homePaths.dir})`;
}

function formatText(results, ctx) {
  const lines = [verdictLine(results, ctx), ''];
  const width = Math.max(...results.map(r => r.title.length));
  for (const r of results) {
    lines.push(`${LABELS[r.status]}  ${r.title.padEnd(width)}  ${r.summary}`);
    for (const p of r.problems) {
      lines.push(`        what: ${p.what}`);
      lines.push(`        why:  ${p.why}`);
      lines.push(`        fix:  ${p.fix}`);
    }
  }
  return lines.join('\n');
}

function formatJson(results, ctx) {
  const status = overallStatus(results);
  return JSON.stringify({ status, exitCode: EXIT_CODES[status], checkout: ctx.checkout, home: ctx.homePaths.dir, at: new Date(ctx.now).toISOString(), checks: results }, null, 2);
}

function main(argv = process.argv.slice(2), sys = createSystem(), out = console.log) {
  const ctx = gather(sys);
  const results = runChecks(ctx);
  out(argv.includes('--json') ? formatJson(results, ctx) : formatText(results, ctx));
  return EXIT_CODES[overallStatus(results)];
}

if (require.main === module) process.exitCode = main();

module.exports = { main, overallStatus, formatText, formatJson, verdictLine, EXIT_CODES };
