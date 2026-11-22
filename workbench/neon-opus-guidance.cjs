const rule = {
  id: 'workbench-neon-plan-opus-execute',
  title: 'Neon → Opus',
  enabled: true,
  suggestedIntent: 'plan',
  suggestedBackendTarget: { kind: 'builtInAgent', agentId: 'gemini' },
  suggestedModelId: 'gemini-4-neon',
  description: [
    'When the user explicitly requests “Neon → Opus” in a Claude Opus session, host the work in this session.',
    'Start one read-only Happier plan run on agent:gemini using gemini-4-neon. Give it the task, relevant context and success criteria.',
    'Wait for that run. On success, use its actual plan to carry out and verify the requested work yourself under the current permissions.',
    'If the wait times out, observe the same run again. If planning fails, report the blocker. Keep the plan and outcome visible in this thread.',
  ].join(' '),
};

function addNeonOpusGuidance(settings) {
  const entries = settings.executionRunsGuidanceEntries ?? [];
  if (entries.some(entry => entry?.id === rule.id)) return settings;
  return { ...settings, executionRunsGuidanceEntries: [...entries, rule] };
}

module.exports = { addNeonOpusGuidance };
