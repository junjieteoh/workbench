import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionAgentSequenceRequestV1 } from '@happier-dev/protocol';
import { claimSessionAgentSequence, createSessionAgentSequenceCoordinator } from './sessionAgentSequence';

const command: SessionAgentSequenceRequestV1 = {
    action: 'sequence', sessionId: 's1', localId: 'seq-one',
    expectedCurrentBackendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    planner: { backendTarget: { kind: 'builtInAgent', agentId: 'gemini' }, modelId: 'chosen-plan', instructions: 'Outline the work.' },
    successor: { backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelId: 'chosen-executor', instructions: 'Use the plan.' },
};
const receipt = { runId: 'plan-1', callId: 'call-1', sidechainId: 'side-1' };
function setup(claim: (request: SessionAgentSequenceRequestV1) => Promise<boolean> = async () => true) {
    let settle!: (plan: string | null) => void;
    const planning = new Promise<string | null>(resolve => { settle = resolve; });
    const runner = { pid: 100, activeTurnId: null as string | null };
    const start = vi.fn(async () => receipt);
    const wait = vi.fn(async () => planning);
    const deliver = vi.fn(async (_request: SessionAgentSequenceRequestV1, _plan: string, canDeliver: () => boolean) => canDeliver());
    const failed = vi.fn();
    const owner = createSessionAgentSequenceCoordinator({ readRunner: () => runner, claim, start, wait, deliver, failed });
    return { owner, runner, start, wait, deliver, failed, settle };
}
describe('native plan and handoff', () => {
    it('shares one receipt, then sends only after this planner finishes with its result', async () => {
        const h = setup();
        const [a, b] = await Promise.all([h.owner.start(command), h.owner.start(command)]);
        expect(a).toEqual({ status: 'started', ...receipt });
        expect(b).toEqual(a);
        expect(h.start).toHaveBeenCalledTimes(1);
        expect(h.deliver).not.toHaveBeenCalled();
        h.settle('Use nested loops.');
        await vi.waitFor(() => expect(h.deliver).toHaveBeenCalledExactlyOnceWith(command, 'Use nested loops.', expect.any(Function)));
        expect(await h.owner.start(command)).toEqual(a);
        expect(h.start).toHaveBeenCalledTimes(1);
    });
    it.each(['failed plan','source changed','new user turn'] as const)('does not take over after %s', async (reason) => {
        const h = setup();
        await h.owner.start(command);
        if (reason === 'source changed') h.runner.pid++;
        if (reason === 'new user turn') h.owner.onParentTurnStarted('s1');
        h.settle(reason === 'failed plan' ? null : 'A finished plan');
        await vi.waitFor(() => expect(h.failed).toHaveBeenCalledTimes(1));
        expect(h.deliver).not.toHaveBeenCalled();
    });
    it('refuses to replay a previous daemon’s attempt and stores no instructions in its claim', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-sequence-'));
        try {
            const claim = (request: SessionAgentSequenceRequestV1) => claimSessionAgentSequence(dir, request);
            const first = setup(claim);
            await first.owner.start(command);
            const restarted = setup(claim);
            expect(await restarted.owner.start(command)).toEqual({ status: 'rejected', reason: 'previous_request' });
            expect(restarted.start).not.toHaveBeenCalled();
            const [name] = await readdir(dir);
            expect(name).toMatch(/^[a-f0-9]{64}$/);
            expect(await readFile(join(dir, name!), 'utf8')).toBe('');
            first.settle(null);
        } finally { await rm(dir, { recursive: true, force: true }); }
    });
    it('rejects busy source, changed retry input and another ongoing sequence', async () => {
        const h = setup();
        h.runner.activeTurnId = 'busy';
        expect(await h.owner.start(command)).toMatchObject({ status: 'rejected', reason: 'source_busy' });
        h.runner.activeTurnId = null;
        await h.owner.start(command);
        expect(await h.owner.start({ ...command, successor: { ...command.successor, instructions: 'A different task.' } })).toMatchObject({ status: 'rejected', reason: 'invalid_request' });
        expect(await h.owner.start({ ...command, localId: 'two' })).toMatchObject({ status: 'rejected', reason: 'already_queued' });
        h.settle('done');
    });
});
