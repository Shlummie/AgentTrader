import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonText, validateDecision, validateReflection } from '../src/schemas.mjs';

const validDecision = {
  action: 'SELL', allocationPct: 37, confidencePct: 61, thesis: 'Test thesis',
  evidence: [{ claim: 'Frozen price evidence', source: 'Frozen snapshot', asOf: null }],
  risks: ['Squeeze risk'], invalidation: 'Break above the high', lessonsUsed: [], researchStatus: 'limited'
};

test('decision contract accepts only BUY or SELL with bounded integer allocation', () => {
  assert.deepEqual(validateDecision(validDecision), validDecision);
  assert.throws(() => validateDecision({ ...validDecision, action: 'HOLD' }), /BUY or SELL/);
  assert.throws(() => validateDecision({ ...validDecision, allocationPct: 10.5 }), /integer/);
  assert.throws(() => validateDecision({ ...validDecision, allocationPct: 101 }), /integer/);
  assert.throws(() => validateDecision({ ...validDecision, confidencePct: -1 }), /integer/);
});

test('JSON parser rejects prose and malformed output but accepts one fenced object', () => {
  assert.deepEqual(parseJsonText('```json\n{"ok":true}\n```'), { ok: true });
  assert.throws(() => parseJsonText('Here is JSON: {"ok":true}'), /one valid JSON object/);
  assert.throws(() => parseJsonText('{bad'), /one valid JSON object/);
});

test('reflection contract separates decision/outcome verdicts and bounds playbook', () => {
  const reflection = {
    verdict: 'good_decision_bad_outcome', dailyReflectionMarkdown: '# Reflection', updatedPlaybookMarkdown: '# Playbook',
    lessons: ['Do not use hindsight.'], sizingAssessment: 'Too large.', confidenceAssessment: 'Overconfident.'
  };
  assert.deepEqual(validateReflection(reflection), reflection);
  assert.throws(() => validateReflection({ ...reflection, verdict: 'win' }), /verdict/);
});
