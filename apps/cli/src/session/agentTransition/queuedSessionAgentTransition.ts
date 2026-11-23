import { isDeepStrictEqual } from 'node:util';

import type {
    SessionAgentTransitionQueueRequestV1,
    SessionAgentTransitionQueueResultV1,
    SessionAgentTransitionRequestV1,
} from '@happier-dev/protocol';

type Summary = Extract<SessionAgentTransitionQueueResultV1, { turnId: string }>;
type QueueEntry = {
    summary: Summary;
    runnerPid: number;
    request?: SessionAgentTransitionRequestV1;
    superseded: boolean;
};
type Runner = Readonly<{ pid: number; activeTurnId: string | null }>;

export function createQueuedSessionAgentTransition(deps: Readonly<{
    readRunner: (sessionId: string) => Runner | null;
    run: (request: SessionAgentTransitionRequestV1, canStopSource: () => boolean) => Promise<boolean>;
}>) {
    // One daemon owns these armed requests across every paired client. Reboot disarms them.
    const entries = new Map<string, QueueEntry>();

    function settle(entry: QueueEntry, status: 'cancelled' | 'completed' | 'failed') {
        entry.summary = { ...entry.summary, status };
        delete entry.request;
    }

    function handle(command: SessionAgentTransitionQueueRequestV1): SessionAgentTransitionQueueResultV1 {
        const entry = entries.get(command.sessionId);
        if (command.action === 'get') return entry?.summary ?? { status: 'empty' };
        if (command.action === 'cancel') {
            if (!entry) return { status: 'empty' };
            if (command.localId !== entry.summary.localId) return { status: 'rejected', reason: 'turn_changed' };
            if (entry.summary.status === 'queued') settle(entry, 'cancelled');
            return entry.summary;
        }

        const { turnId, transition } = command;
        if (transition.sessionId !== command.sessionId) return { status: 'rejected', reason: 'invalid_request' };
        if (entry?.summary.localId === transition.input.localId) {
            if (entry.summary.turnId !== turnId || (entry.request && !isDeepStrictEqual(entry.request, transition))) {
                return { status: 'rejected', reason: 'invalid_request' };
            }
            return entry.summary;
        }
        if (entry?.summary.status === 'queued' || entry?.summary.status === 'dispatching') {
            return { status: 'rejected', reason: 'already_queued' };
        }
        const runner = deps.readRunner(command.sessionId);
        if (!runner || runner.activeTurnId !== turnId) return { status: 'rejected', reason: 'turn_changed' };
        const summary: Summary = { status: 'queued', turnId, localId: transition.input.localId, target: transition.selection };
        entries.set(command.sessionId, { summary, runnerPid: runner.pid, request: transition, superseded: false });
        return summary;
    }

    function startTurn(sessionId: string, turnId: string | undefined) {
        const entry = entries.get(sessionId);
        if (!entry || turnId === entry.summary.turnId) return;
        if (entry.summary.status === 'dispatching') entry.superseded = true;
        // A turnless prompt can also be a steer on the already tracked source turn.
        if (turnId && entry.summary.status === 'queued') settle(entry, 'failed');
    }

    async function finishTurn(sessionId: string, turnId: string, status: 'completed' | 'cancelled' | 'failed') {
        const entry = entries.get(sessionId);
        if (!entry?.request || entry.summary.status !== 'queued' || entry.summary.turnId !== turnId) return;
        const canStopSource = () => {
            const runner = deps.readRunner(sessionId);
            return !entry.superseded && runner?.pid === entry.runnerPid && runner.activeTurnId === null;
        };
        if (status !== 'completed') {
            settle(entry, status);
            return;
        }
        if (!canStopSource()) {
            settle(entry, 'failed');
            return;
        }

        entry.summary = { ...entry.summary, status: 'dispatching' };
        try {
            const accepted = await deps.run(entry.request, canStopSource);
            settle(entry, accepted ? 'completed' : 'failed');
        } catch {
            // A lost answer can follow cutover. Never automatically replay the input.
            settle(entry, 'failed');
        }
    }

    function failQueuedForRunner(sessionId: string, runnerPid: number, turnId?: string) {
        const entry = entries.get(sessionId);
        if (entry?.runnerPid !== runnerPid || entry.summary.status !== 'queued') return;
        if (turnId === undefined || entry.summary.turnId === turnId) settle(entry, 'failed');
    }

    return { handle, startTurn, finishTurn, failQueuedForRunner };
}
