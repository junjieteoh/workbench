import { describe, expect, it, vi } from 'vitest';
import type { SessionAgentTurnSequenceRequestV1 } from '@happier-dev/protocol';
import { createForegroundTurnSequence } from './sessionAgentTurnSequence';

const writer = { kind: 'builtInAgent', agentId: 'claude' } as const;
const reviewer = { kind: 'builtInAgent', agentId: 'gemini' } as const;
const command: SessionAgentTurnSequenceRequestV1 = {
    action: 'turn_sequence', sessionId: 's1', localId: 'request', expectedCurrentBackendTarget: writer,
    steps: [writer, reviewer, writer].map((backendTarget, index) => ({ backendTarget, modelId: null, instructions: ['Draft', 'Review', 'Revise'][index]! })),
};
function setup() {
    const runner = { pid: 1, activeTurnId: null as string | null, supportsInPlaceSequence: true };
    const dispatch = vi.fn(async (_request: SessionAgentTurnSequenceRequestV1, _index: number, _localId: string, guard: () => boolean) => guard());
    const stopped = vi.fn(async () => {});
    const owner = createForegroundTurnSequence({ readRunner: () => runner, claim: async () => true, dispatch, stopped });
    function bind(index: number, turnId: string) {
        const localId = dispatch.mock.calls[index]![2];
        owner.onInput('s1', localId);
        runner.activeTurnId = turnId;
        owner.onBegin('s1', runner.pid, turnId, [localId]);
    }
    async function end(turnId: string, success = true) {
        runner.activeTurnId = null;
        await owner.onTerminal('s1', runner.pid, turnId, success);
    }
    return { owner, dispatch, stopped, runner, bind, end };
}
describe('ordered foreground turns', () => {
    it('rejects work on an older adopted runner before its first prompt and permits a switch to a fresh runner', async () => {
        const h = setup();
        h.runner.supportsInPlaceSequence = false;
        expect(await h.owner.start(command)).toEqual({ status: 'rejected', reason: 'source_runtime_update_required' });
        expect(h.dispatch).not.toHaveBeenCalled();

        const switchFirst = { ...command, steps: [command.steps[1]!, command.steps[0]!] };
        expect(await h.owner.start(switchFirst)).toEqual({ status: 'started' });
        expect(h.dispatch).toHaveBeenCalledTimes(1);
    });

    it('runs A → B → A only upon each exact successful turn and never dispatches a fourth input', async () => {
        const h = setup();
        expect(await h.owner.start(command)).toEqual({ status: 'started' });
        expect(await h.owner.start(command)).toEqual({ status: 'started' });
        h.bind(0, 't0'); await h.end('t0');
        h.runner.pid = 2; h.bind(1, 't1');
        await h.owner.onTerminal('s1', 1, 't0', true);
        expect(h.dispatch).toHaveBeenCalledTimes(2);
        await h.end('t1');
        h.runner.pid = 3; h.bind(2, 't2'); await h.end('t2');
        expect(h.dispatch.mock.calls.map(call => call[1])).toEqual([0, 1, 2]);
        expect(new Set(h.dispatch.mock.calls.map(call => call[2])).size).toBe(3);
        expect(h.stopped).not.toHaveBeenCalled();
        expect(h.owner.isActive('s1')).toBe(false);
    });
    it.each(['steer', 'failure', 'unbound', 'lost runner'] as const)('halts on %s before taking over', async reason => {
        const h = setup();
        await h.owner.start(command);
        if (reason !== 'unbound') h.bind(0, 'turn');
        if (reason === 'steer') h.owner.onInput('s1', 'human');
        if (reason === 'lost runner') h.owner.onExit('s1', 1);
        await h.end('turn', reason !== 'failure');
        expect(h.dispatch).toHaveBeenCalledTimes(1);
        expect(h.stopped).toHaveBeenCalledTimes(1);
        expect(h.owner.isActive('s1')).toBe(false);
    });
    it('refuses a binding on the departing runner even if its agent later returns', async () => {
        const h = setup();
        await h.owner.start(command);
        h.bind(0, 'draft');
        await h.end('draft');
        h.bind(1, 'stale-old-runner-turn');
        expect(h.stopped).toHaveBeenCalledTimes(1);
        expect(h.owner.isActive('s1')).toBe(false);
        await h.end('stale-old-runner-turn');
        expect(h.dispatch).toHaveBeenCalledTimes(2);
    });
    it('disarms an exact blocked delivery before a provider even opens a turn', async () => {
        const h = setup();
        await h.owner.start(command);
        h.owner.onDeliveryBlocked('s1', 'unrelated-pending-input');
        expect(h.owner.isActive('s1')).toBe(true);
        h.owner.onDeliveryBlocked('s1', h.dispatch.mock.calls[0]![2]);
        expect(h.owner.isActive('s1')).toBe(false);
        expect(h.stopped).toHaveBeenCalledTimes(1);
        expect(h.dispatch).toHaveBeenCalledTimes(1);
    });
    it('keeps an in-flight request isolated from both a competing chain and a changed retry', async () => {
        const h = setup();
        await h.owner.start(command);
        expect(await h.owner.start({ ...command, localId: 'competing' })).toMatchObject({ reason: 'already_queued' });
        expect(await h.owner.start({ ...command, steps: [...command.steps].reverse().map(s => ({ ...s, instructions: 'changed' })) })).toMatchObject({ reason: 'invalid_request' });
        expect(h.dispatch).toHaveBeenCalledTimes(1);
    });
});
