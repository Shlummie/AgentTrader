import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOmpJsonl } from '../src/omp.mjs';

function jsonl(model = 'gpt-5.6-sol', provider = 'openai-codex') {
  return [
    JSON.stringify({ type: 'tool_execution_start', toolName: 'web_search', args: { query: 'AAPL earnings date' } }),
    JSON.stringify({ type: 'tool_execution_end', toolName: 'web_search', result: { content: 'Result https://example.com/aapl#section' } }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider, model, usage: { input: 10, output: 5 }, content: [{ type: 'thinking', thinking: 'private scratchpad' }, { type: 'text', text: '{"ok":true}' }] } })
  ].join('\n');
}

test('OMP protocol requires the exact subscription provider/model identity', () => {
  const parsed = parseOmpJsonl(jsonl());
  assert.equal(parsed.model.provider, 'openai-codex');
  assert.equal(parsed.model.id, 'gpt-5.6-sol');
  assert.equal(parsed.model.reasoningEffort, 'max');
  assert.equal(parsed.finalText, '{"ok":true}');
  assert.deepEqual(parsed.research.queries, ['AAPL earnings date']);
  assert.deepEqual(parsed.research.sources, ['https://example.com/aapl']);
  assert.doesNotMatch(JSON.stringify(parsed), /private scratchpad/);
  assert.throws(() => parseOmpJsonl(jsonl('gpt-5.6-terra')), (error) => error.code === 'OMP_MODEL_MISMATCH');
});

test('OMP protocol rejects non-JSON output without retaining its contents', () => {
  const secretReasoning = 'my private chain of thought';
  assert.throws(() => parseOmpJsonl(secretReasoning), (error) => {
    assert.equal(error.code, 'OMP_PROTOCOL_FAILURE');
    assert.doesNotMatch(JSON.stringify(error.details || {}), /private chain/);
    return true;
  });
});

test('any tool other than web_search fails closed', () => {
  const output = `${JSON.stringify({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'dir' } })}\n${jsonl()}`;
  assert.throws(() => parseOmpJsonl(output), (error) => error.code === 'OMP_DISALLOWED_TOOL');
});
