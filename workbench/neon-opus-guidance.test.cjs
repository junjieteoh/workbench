const assert = require('node:assert/strict');
const test = require('node:test');
const { addNeonOpusGuidance } = require('./neon-opus-guidance.cjs');

test('adds one opt-in rule alongside existing guidance and preserves account preferences', () => {
  const existing = { id: 'my-rule', description: 'Keep my rule.' };
  const settings = { executionRunsGuidanceEntries: [existing], executionRunsNotifyParentOnCompletionDefault: false };
  const updated = addNeonOpusGuidance(settings);
  const [first, preset] = updated.executionRunsGuidanceEntries;
  assert.equal(first, existing);
  assert.equal(preset.suggestedIntent, 'plan');
  assert.equal(preset.suggestedBackendTarget.agentId, 'gemini');
  assert.equal(preset.suggestedModelId, 'gemini-4-neon');
  assert.equal(updated.executionRunsNotifyParentOnCompletionDefault, false);
  assert.deepEqual(settings.executionRunsGuidanceEntries, [existing]);
  assert.equal(addNeonOpusGuidance(updated), updated);
});

test('a reinstall preserves an edited or disabled rule', () => {
  const [preset] = addNeonOpusGuidance({}).executionRunsGuidanceEntries;
  const settings = { executionRunsGuidanceEntries: [{ ...preset, enabled: false, description: 'My version.' }] };
  assert.equal(addNeonOpusGuidance(settings), settings);
});
