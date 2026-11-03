import test from 'node:test';
import assert from 'node:assert/strict';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { EXTRACTION_OUTPUT_SCHEMA, buildExtractionInvocation, parseExtractionOutput } from '../dist/adapters/claude-code.js';
import { buildCodexExtractionInvocation } from '../dist/adapters/codex.js';
import { buildOpenCodeExtractionInvocation } from '../dist/adapters/opencode.js';
import { buildHermesExtractionInvocation } from '../dist/adapters/hermes.js';
import { createPiAdapter } from '../dist/adapters/pi.js';
import { LIMITS } from '../dist/assets/protocol.js';
import { validateProposedAsset } from '../dist/assets/validation.js';

const request = { job_uid: 'synthetic-job', runtime_kind: 'claude-code', native_session_id: 'synthetic-session', source_event_refs: ['event'], binding_uid: 'binding', binding_revision: 1, soul_uid: 'soul', internal_task: true };
const proposal = (kind = 'relationship') => ({ kind, trait: kind === 'experience' ? 'fact' : 'preference', content: 'A concise durable preference.', applicability: 'future summaries', tags: [], evidence: 'explicit_user_statement', verification: 'unverified', sensitivity: 'normal' });
const source = { runtime_kind: 'claude-code', session_ref: '', event_ref: 'u', occurred_at: '2026-11-04T00:00:00Z' };
const validate = new AjvJsonSchemaValidator().getValidator(EXTRACTION_OUTPUT_SCHEMA);
const boundaries = [
  ['relationship content 200 Unicode codepoints', p => { p.content = '🪁'.repeat(200); }, true],
  ['relationship content 201', p => { p.content = 'x'.repeat(201); }, false],
  ['confirmed live regression relationship content 205', p => { p.content = 'x'.repeat(205); p.applicability = 'x'.repeat(126); p.tags = Array(5).fill('x'.repeat(16)); }, false],
  ['experience content 4000', p => { p.kind = 'experience'; p.trait = 'fact'; p.content = '🪁'.repeat(4000); }, true],
  ['experience content 4001', p => { p.kind = 'experience'; p.trait = 'fact'; p.content = 'x'.repeat(4001); }, false],
  ['applicability 500', p => { p.applicability = '🪁'.repeat(500); }, true],
  ['applicability 501', p => { p.applicability = 'x'.repeat(501); }, false],
  ['eight tags', p => { p.tags = Array(8).fill('tag'); }, true],
  ['nine tags', p => { p.tags = Array(9).fill('tag'); }, false],
  ['tag 32 Unicode codepoints', p => { p.tags = ['🪁'.repeat(32)]; }, true],
  ['tag 33', p => { p.tags = ['x'.repeat(33)]; }, false],
];
for (const [name, mutate, expected] of boundaries) {
  test(`extraction limits: full schema and strict wire validator agree on ${name}`, () => {
    const p = proposal(); mutate(p);
    assert.equal(validate({ proposals: [p] }).valid, expected, name);
    if (expected) assert.doesNotThrow(() => validateProposedAsset({ ...p, source }));
    else assert.throws(() => validateProposedAsset({ ...p, source }));
  });
}

function assertPrompt(input) {
  const instructions = input.split('--- completed turn ---')[0];
  assert.match(instructions, /relationship.*200.*Unicode code points/i);
  assert.match(instructions, /experience.*4000.*Unicode code points/i);
  assert.match(instructions, /applicability.*500.*Unicode code points/i);
  assert.match(instructions, /tags.*8.*32.*Unicode code points/i);
  assert.match(instructions, /summarize.*faithfully|faithfully.*summarize/i);
  assert.match(instructions, /verify.*limits|check.*limits/i);
}
const builders = [
  ['Claude', () => buildExtractionInvocation(request, 'synthetic')],
  ['Codex', () => buildCodexExtractionInvocation({ ...request, runtime_kind: 'codex' }, 'synthetic')],
  ['OpenCode v1', () => buildOpenCodeExtractionInvocation({ ...request, runtime_kind: 'opencode' }, 'synthetic', 'v1')],
  ['OpenCode v2', () => buildOpenCodeExtractionInvocation({ ...request, runtime_kind: 'opencode' }, 'synthetic', 'v2')],
  ['Hermes', () => buildHermesExtractionInvocation({ ...request, runtime_kind: 'hermes' }, 'synthetic')],
];
for (const [name, build] of builders) test(`extraction limits: ${name} receives the shared wire bounds before source data`, () => assertPrompt(build().input));

test('extraction limits: Pi receives the same bounds through its actual mocked native invocation seam', async () => {
  const transcript = [
    { type: 'session', id: 'session', version: 3 },
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'Synthetic durable preference.' } },
    { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: [{ type: 'text', text: 'Understood.' }], stopReason: 'stop' } },
  ].map(x => JSON.stringify(x)).join('\n');
  let calls = 0;
  const adapter = createPiAdapter({ home: '/synthetic', emit: async () => {}, readSource: async () => transcript, invoke: async (_kind, _args, input) => { calls++; assertPrompt(input); return { code: 0, stdout: '{"proposals":[]}', stderr: '' }; } });
  const result = await adapter.extract({ ...request, runtime_kind: 'pi', source_turn_refs: ['u', 'a'] });
  assert.deepEqual(result, { proposals: [] }); assert.equal(calls, 1);
});

test('extraction limits: native Claude schema describes per-kind bounds without unsupported API constraints', () => {
  const invocation = buildExtractionInvocation(request, 'synthetic');
  const native = JSON.parse(invocation.args[invocation.args.indexOf('--json-schema') + 1]);
  const descriptions = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    assert.ok(!Object.hasOwn(value, 'maxLength') && !Object.hasOwn(value, 'maxItems'), 'Claude API rejects these unsupported keywords; keep strict local validation');
    if (typeof value.description === 'string') descriptions.push(value.description);
    for (const child of Object.values(value)) visit(child);
  };
  visit(native);
  const text = descriptions.join('\n');
  for (const limit of [LIMITS.relationshipContentMaxCodePoints, LIMITS.experienceContentMaxCodePoints, LIMITS.applicabilityMaxCodePoints, LIMITS.tagsMax, LIMITS.tagMaxCodePoints]) assert.ok(text.includes(String(limit)));
  assert.match(text, /relationship.*200|200.*relationship/i);
  assert.match(text, /experience.*4000|4000.*experience/i);
  assert.equal(new AjvJsonSchemaValidator().getValidator(native)({ proposals: [proposal()] }).valid, true);
});

test('extraction limits: an over-limit native result is never silently truncated or accepted', () => {
  const p = proposal(); p.content = 'x'.repeat(205);
  const result = parseExtractionOutput(JSON.stringify({ structured_output: { proposals: [p] }, subtype: 'success', is_error: false }), request, ['u']);
  assert.equal(result.proposals[0].content, p.content);
  assert.throws(() => validateProposedAsset(result.proposals[0]), error => error.reason === 'content_limit');
});
