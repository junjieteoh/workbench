import { describe, expect, it, vi } from 'vitest';
import type { SessionAgentTransitionRequestV1 } from '@happier-dev/protocol';

import { createQueuedSessionAgentTransition } from './queuedSessionAgentTransition';

const transition: SessionAgentTransitionRequestV1 = {
    v: 1,
    sessionId: 'session-a',
    expectedCurrentAgentId: 'source',
    selection: { v: 1, agentId: 'target', modelId: 'user-choice' },
    input: { localId: 'instruction-1', text: 'Use the findings.', meta: {} },
};
const schedule = { action: 'schedule', sessionId: transition.sessionId, turnId: 'turn-1', transition } as const;
const get = { action: 'get', sessionId: transition.sessionId } as const;
const cancel = { action: 'cancel', sessionId: transition.sessionId, localId: transition.input.localId } as const;

function setup() {
    const runner = { pid: 1234, activeTurnId: 'turn-1' as string | null };
    const run = vi.fn(async (_request: SessionAgentTransitionRequestV1, _canStopSource: () => boolean) => true);
    const queue = createQueuedSessionAgentTransition({ readRunner: () => runner, run });
    const finish = async (status: 'completed' | 'failed' | 'cancelled') => {
        runner.activeTurnId = null;
        await queue.finishTurn(transition.sessionId, 'turn-1', status);
    };
    return { queue, runner, run, finish };
}

describe('queued same-session agent transition', () => {
    it('binds the exact source turn, keeps the chosen model and input, and runs once after completion', async () => {
        const { queue, run, finish } = setup();
        expect(queue.handle(schedule)).toMatchObject({ status: 'queued', target: transition.selection });
        expect(queue.handle(schedule)).toEqual(queue.handle(get));
        expect(queue.handle({ ...schedule, transition: { ...transition, input: { ...transition.input, text: 'Changed retry' } } })).toMatchObject({ status: 'rejected' });
        expect(queue.handle({ ...schedule, transition: { ...transition, input: { ...transition.input, localId: 'other' } } })).toMatchObject({ reason: 'already_queued' });
        await queue.finishTurn(transition.sessionId, 'other-turn', 'completed');
        expect(run).not.toHaveBeenCalled();
        await finish('completed');
        expect(run).toHaveBeenCalledExactlyOnceWith(transition, expect.any(Function));
        expect(queue.handle(get)).toMatchObject({ status: 'completed' });
        expect(queue.handle(schedule)).toMatchObject({ status: 'completed' });
        await finish('completed');
        expect(run).toHaveBeenCalledTimes(1);
    });

    it.each(['failed', 'cancelled'] as const)('does not advance a %s source turn', async status => {
        const { queue, run, finish } = setup();
        queue.handle(schedule);
        await finish(status);
        expect(run).not.toHaveBeenCalled();
        expect(queue.handle(get)).toMatchObject({ status });
    });

    it('refuses stale choices, honours matching cancellation, and leaves other users’ choices intact', async () => {
        const { queue, runner, run, finish } = setup();
        expect(queue.handle({ ...schedule, turnId: 'old-turn' })).toMatchObject({ reason: 'turn_changed' });
        queue.handle(schedule);
        expect(queue.handle({ ...cancel, localId: 'other-choice' })).toMatchObject({ status: 'rejected' });
        expect(queue.handle(get)).toMatchObject({ status: 'queued' });
        expect(queue.handle(cancel)).toMatchObject({ status: 'cancelled' });
        expect(queue.handle(schedule)).toMatchObject({ status: 'cancelled' });
        await finish('completed');
        expect(run).not.toHaveBeenCalled();
        runner.activeTurnId = 'other-turn';
        expect(queue.handle({ ...schedule, turnId: 'other-turn', transition: { ...transition, input: { ...transition.input, localId: 'new' } } })).toMatchObject({ status: 'queued' });
    });

    it('withdraws stop authorization if another turn starts while the native transition awaits I/O', async () => {
        const { queue, runner, run, finish } = setup();
        run.mockImplementationOnce(async (_request, canStop) => {
            expect(canStop()).toBe(true);
            queue.startTurn(transition.sessionId, 'new-turn');
            runner.activeTurnId = 'new-turn';
            expect(canStop()).toBe(false);
            return false;
        });
        queue.handle(schedule);
        await finish('completed');
        expect(queue.handle(get)).toMatchObject({ status: 'failed' });
    });

    it('a replacement runner or vanished source never inherits an earlier queue', async () => {
        const { queue, runner, run, finish } = setup();
        queue.handle(schedule);
        runner.pid++;
        await finish('completed');
        expect(run).not.toHaveBeenCalled();
        expect(queue.handle(get)).toMatchObject({ status: 'failed' });
    });

    it('disarms only the matching runner and turn if its terminal marker could not be written', async () => {
        const { queue, runner, run, finish } = setup();
        queue.handle(schedule);
        queue.failQueuedForRunner(transition.sessionId, runner.pid + 1, schedule.turnId);
        queue.failQueuedForRunner(transition.sessionId, runner.pid, 'stale-turn');
        expect(queue.handle(get)).toMatchObject({ status: 'queued' });
        queue.failQueuedForRunner(transition.sessionId, runner.pid, schedule.turnId);
        expect(queue.handle(get)).toMatchObject({ status: 'failed' });
        await finish('completed');
        expect(run).not.toHaveBeenCalled();
    });

    it('reports failed admission and permits retrying with a new choice only', async () => {
        const { queue, run, finish } = setup();
        run.mockRejectedValueOnce(new Error('connection lost'));
        queue.handle(schedule);
        await finish('completed');
        expect(queue.handle(schedule)).toMatchObject({ status: 'failed' });
        expect(run).toHaveBeenCalledTimes(1);
    });
});
