import test from 'node:test';
import assert from 'node:assert/strict';
import { filterReports, groupReports, reportsFromTree } from '../src/extensions/reports/reports.ts';

const BS = String.fromCharCode(92);

test('reports are the text files under .pigry/reports, grouped by the agent folder', () => {
  const reports = reportsFromTree([
    'src/app.ts',
    '.pigry/reports/qa/login-cases.md',
    '.pigry/reports/qa/evidence/TC-01.png',
    '.pigry/reports/qa/notes/day-1.markdown',
    '.pigry/reports/white-hat/review.MD',
    '.pigry/reports/overview.txt',
    '.pigry/boards/sa/retro.board.json',
    '.pigry/reports/',
    '.pigry' + BS + 'reports' + BS + 'uxui' + BS + 'handoff.md',
  ]);
  assert.deepEqual(reports.map((r) => [r.owner, r.name]), [
    ['qa', 'login-cases.md'], ['qa', 'notes/day-1.markdown'], ['white-hat', 'review.MD'], ['', 'overview.txt'], ['uxui', 'handoff.md'],
  ]);
  assert.equal(reports.at(-1).path, '.pigry/reports/uxui/handoff.md', 'Windows separators are normalised');
  const groups = groupReports(reports);
  assert.deepEqual(groups.map((g) => g.owner), ['', 'qa', 'uxui', 'white-hat']);
  assert.deepEqual(groups[1].reports.map((r) => r.name), ['login-cases.md', 'notes/day-1.markdown']);
});

test('filtering matches the agent, file name or path, ignoring case', () => {
  const reports = reportsFromTree(['.pigry/reports/qa/Login.md', '.pigry/reports/uxui/handoff.md']);
  assert.deepEqual(filterReports(reports, ' LOGIN ').map((r) => r.owner), ['qa']);
  assert.deepEqual(filterReports(reports, 'uxui').map((r) => r.name), ['handoff.md']);
  assert.equal(filterReports(reports, '').length, 2);
  assert.equal(filterReports(reports, 'zzz').length, 0);
});
