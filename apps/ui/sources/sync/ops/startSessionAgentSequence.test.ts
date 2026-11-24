import { beforeEach, describe, expect, it, vi } from 'vitest';

const { submit, detect, ensureVisible, readState } = vi.hoisted(() => ({
    submit: vi.fn(), detect: vi.fn(), ensureVisible: vi.fn(), readState: vi.fn(),
}));
vi.mock('@/sync/ops/sessionAgentTransition', () => ({ sessionAgentTurnSequenceOnMachine: submit }));
vi.mock('@/sync/ops/capabilities', () => ({ machineCapabilitiesDetect: detect }));
vi.mock('@/sync/sync', () => ({ sync: { ensureSessionVisibleForMessageRoute: ensureVisible } }));
vi.mock('@/sync/domains/state/storage', () => ({ storage: { getState: readState } }));

import { startSessionAgentSequence, type StartSessionAgentSequenceParams } from './startSessionAgentSequence';

const claude = { kind: 'builtInAgent', agentId: 'claude' } as const;
const gemini = { kind: 'builtInAgent', agentId: 'gemini' } as const;
const input: StartSessionAgentSequenceParams = {
    machineId: 'machine-x', sessionId: 'thread-a', serverId: 'private', expectedCurrentAgentId: 'claude',
    expectedCurrentBackendTarget: claude, startRequestId: 'composer-1',
    steps: [
        { backendTarget: claude, modelId: 'first-model', instructions: 'Draft the update.' },
        { backendTarget: gemini, modelId: null, instructions: 'Review the draft.' },
        { backendTarget: claude, modelId: 'second-model', instructions: 'Revise based on the review.' },
    ],
};

describe('submit an ordered sequence of foreground turns', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        detect.mockResolvedValue({ supported: true, response: { results: { 'tool.sessionAgentTransition': { ok: true, data: { supportsAgentTurnSequence: true } } } } });
        submit.mockResolvedValue({ status: 'started' });
    });

    it('sends every previewed instruction and chosen model in one request to the owning machine', async () => {
        expect(await startSessionAgentSequence(input)).toEqual({ ok: true });
        expect(submit).toHaveBeenCalledWith({
            machineId: 'machine-x', serverId: 'private',
            request: { action: 'turn_sequence', sessionId: 'thread-a', localId: 'composer-1', expectedCurrentBackendTarget: claude, steps: input.steps },
        });
    });

    it('does not submit to an older daemon or an inconsistent source selection', async () => {
        expect((await startSessionAgentSequence({ ...input, expectedCurrentAgentId: 'codex' })).ok).toBe(false);
        detect.mockResolvedValue({ supported: true, response: { results: { 'tool.sessionAgentTransition': { ok: true, data: { supportsAgentSequence: true } } } } });
        expect((await startSessionAgentSequence(input)).ok).toBe(false);
        expect(submit).not.toHaveBeenCalled();
    });

    it('waits for relay activity and machine binding after Resume before submitting any turn', async () => {
        let activate!: () => void;
        const activating = new Promise<void>(resolve => { activate = resolve; });
        ensureVisible.mockReturnValue(activating);
        readState.mockReturnValue({ sessions: { 'thread-a': { active: false, metadata: { machineId: 'machine-x' } } } });
        const sending = startSessionAgentSequence({ ...input, waitForRunnerPresence: true });
        await vi.waitFor(() => expect(ensureVisible).toHaveBeenCalledWith('thread-a', { forceRefresh: true, serverId: 'private' }));
        expect(submit).not.toHaveBeenCalled();
        readState.mockReturnValue({ sessions: { 'thread-a': { active: true, metadata: { machineId: 'machine-x' } } } });
        activate();
        expect(await sending).toEqual({ ok: true });
        expect(submit).toHaveBeenCalledTimes(1);
    });

    it('does not silently accept or replay an uncertain dispatch', async () => {
        submit.mockRejectedValue(new Error('Lost response'));
        expect((await startSessionAgentSequence(input)).ok).toBe(false);
        expect(submit).toHaveBeenCalledTimes(1);
    });
});
