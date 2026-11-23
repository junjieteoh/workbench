import { beforeEach, describe, expect, it, vi } from 'vitest';
const { execute, detect } = vi.hoisted(() => ({ execute: vi.fn(), detect: vi.fn() }));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({ createDefaultActionExecutor: () => ({ execute }) }));
vi.mock('@/sync/ops/capabilities', () => ({ machineCapabilitiesDetect: detect }));
import { startSessionAgentSequence } from './startSessionAgentSequence';
const lead = { kind: 'builtInAgent', agentId: 'codex' } as const;
const input = {
    machineId: 'machine-x', sessionId: 'thread-a', serverId: 'private', expectedCurrentAgentId: 'codex',
    expectedCurrentBackendTarget: lead, planner: { backendTarget: { kind: 'builtInAgent', agentId: 'gemini' }, modelId: 'selected-planner', instructions: 'Plan first.' },
    successor: { backendTarget: { kind: 'configuredAcpBackend', backendId: 'the-team-editor' }, modelId: null, instructions: 'Take over.' },
    context: 'Design a fountain.', startRequestId: 'composer-1',
} as const;
describe('submit both composer steps', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        detect.mockResolvedValue({ supported: true, response: { results: { 'tool.sessionAgentTransition': { ok: true, data: { supportsAgentSequence: true } } } } });
        execute.mockResolvedValue({ ok: true, result: { results: [{ key: 'agent:gemini', ok: true, result: { status: 'started', runId: 'run7' } }] } });
    });
    it('pins both targets, selected models, original lead and conversation together on approval and retry', async () => {
        expect(await startSessionAgentSequence(input)).toEqual({ ok: true, status: 'started' });
        expect(execute).toHaveBeenCalledWith('subagents.plan.start', {
            sessionId: 'thread-a', backendTargetKeys: ['agent:gemini'], modelId: 'selected-planner', instructions: expect.stringContaining('Design a fountain.'),
            sequence: { machineId: 'machine-x', localId: 'composer-1', expectedCurrentBackendTarget: lead, successor: input.successor },
        }, { serverId: 'private', defaultSessionId: 'thread-a', surface: 'ui_button', actionRequestId: 'composer-1' });
        execute.mockResolvedValue({ ok:true, result:{ kind:'approval_request_created', artifactId:'a1' } });
        expect(await startSessionAgentSequence(input)).toEqual({ ok: true, status: 'awaiting_approval' });
    });
    it('sends nothing to an older daemon or an inconsistent source selection', async () => {
        expect((await startSessionAgentSequence({ ...input, expectedCurrentAgentId: 'claude' })).ok).toBe(false);
        detect.mockResolvedValue({ supported:true, response:{ results:{ 'tool.sessionAgentTransition':{ ok:true, data:{ supportsInputPermissionIntent:true } } } } });
        expect((await startSessionAgentSequence(input)).ok).toBe(false);
        expect(execute).not.toHaveBeenCalled();
    });
});
