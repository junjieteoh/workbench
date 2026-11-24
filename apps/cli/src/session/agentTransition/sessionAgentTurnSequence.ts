import { createHash } from 'node:crypto';
import {
    buildBackendTargetKey,
    type SessionAgentTurnSequenceRequestV1 as Request,
    type SessionAgentTurnSequenceResultV1 as Result,
} from '@happier-dev/protocol';
import { fingerprintExecutionRunStartRequest } from '@/agent/executionRuns/executionRunStartFingerprint';

import { FOREGROUND_SEQUENCE_STEP_PREFIX } from './foregroundSequenceStepId';

type Step = {
    index: number;
    localId: string;
    sourcePid: number;
    switchesRunner: boolean;
    turn: { id: string; pid: number } | null;
};
type Active = { command: Request; step: Step };
type StopReason = 'failed' | 'interrupted' | 'unconfirmed';

export function createForegroundTurnSequence(deps: Readonly<{
    readRunner: (sessionId: string) => { pid: number; activeTurnId: string | null } | null;
    claim: (command: Request) => Promise<boolean>;
    dispatch: (command: Request, index: number, localId: string, guard: () => boolean) => Promise<boolean>;
    stopped: (command: Request, reason: StopReason, index: number) => Promise<void>;
}>) {
    const active = new Map<string, Active>();
    const receipts = new Map<string, { fingerprint: string; receipt: Promise<Result> }>();

    function stepFor(command: Request, index: number, sourcePid: number): Step {
        const from = command.steps[index - 1]?.backendTarget ?? command.expectedCurrentBackendTarget;
        const digest = createHash('sha256').update(JSON.stringify([command.sessionId, command.localId, index])).digest('hex');
        return {
            index, sourcePid, turn: null,
            localId: FOREGROUND_SEQUENCE_STEP_PREFIX + digest,
            switchesRunner: buildBackendTargetKey(from) !== buildBackendTargetKey(command.steps[index]!.backendTarget),
        };
    }
    function stop(entry: Active, reason: StopReason) {
        if (active.get(entry.command.sessionId) !== entry) return;
        active.delete(entry.command.sessionId);
        void deps.stopped(entry.command, reason, entry.step.index).catch(() => {});
    }
    async function dispatch(entry: Active): Promise<boolean> {
        const { command, step } = entry;
        const guard = () => {
            const runner = deps.readRunner(command.sessionId);
            return active.get(command.sessionId) === entry && entry.step === step
                && runner?.pid === step.sourcePid && runner.activeTurnId === null;
        };
        return guard() && deps.dispatch(command, step.index, step.localId, guard);
    }
    function start(command: Request): Promise<Result> {
        const key = JSON.stringify([command.sessionId, command.localId]);
        const fingerprint = fingerprintExecutionRunStartRequest(command);
        const previous = receipts.get(key);
        if (previous) {
            return previous.fingerprint === fingerprint ? previous.receipt : Promise.resolve({ status: 'rejected', reason: 'invalid_request' });
        }
        if (active.has(command.sessionId)) return Promise.resolve({ status: 'rejected', reason: 'already_queued' });
        const source = deps.readRunner(command.sessionId);
        if (!source || source.activeTurnId !== null) return Promise.resolve({ status: 'rejected', reason: 'source_busy' });
        const entry = { command, step: stepFor(command, 0, source.pid) };
        active.set(command.sessionId, entry);
        const receipt = Promise.resolve().then(async (): Promise<Result> => {
            try {
                if (!await deps.claim(command)) return { status: 'rejected', reason: 'previous_request' };
                if (await dispatch(entry)) return { status: 'started' };
                return { status: 'rejected', reason: 'step_start_failed' };
            } catch { return { status: 'rejected', reason: 'step_start_failed' }; }
        }).then(result => {
            if (result.status === 'rejected' && active.get(command.sessionId) === entry) active.delete(command.sessionId);
            return result;
        });
        receipts.set(key, { fingerprint, receipt });
        return receipt;
    }

    return {
        start,
        isActive: (sessionId: string) => active.has(sessionId),
        onInput(sessionId: string, localId?: string) {
            const entry = active.get(sessionId);
            if (entry && entry.step.localId !== localId) stop(entry, 'interrupted');
        },
        onDeliveryBlocked(sessionId: string, localId?: string) {
            const entry = active.get(sessionId);
            if (entry && entry.step.localId === localId) stop(entry, 'failed');
        },
        onBegin(sessionId: string, pid: number, turnId: string, localIds?: readonly string[]) {
            const entry = active.get(sessionId);
            if (!entry || deps.readRunner(sessionId)?.pid !== pid) return;
            const { step } = entry;
            if (step.turn && (step.turn.id !== turnId || step.turn.pid !== pid)) return stop(entry, 'interrupted');
            if (!localIds?.length) return; // Some providers publish a provisional start before the exact input binding.
            const expectedRunner = step.switchesRunner ? pid !== step.sourcePid : pid === step.sourcePid;
            if (!expectedRunner || localIds.length !== 1 || localIds[0] !== step.localId) return stop(entry, 'interrupted');
            step.turn = { id: turnId, pid };
        },
        async onTerminal(sessionId: string, pid: number, turnId: string | undefined, completed: boolean) {
            const entry = active.get(sessionId);
            const runner = deps.readRunner(sessionId);
            if (!entry || runner?.pid !== pid) return;
            const { step } = entry;
            if (!step.turn || step.turn.pid !== pid || step.turn.id !== turnId) return stop(entry, 'unconfirmed');
            if (!completed || runner.activeTurnId !== null) return stop(entry, completed ? 'interrupted' : 'failed');
            const next = step.index + 1;
            if (next === entry.command.steps.length) {
                active.delete(sessionId);
                return;
            }
            entry.step = stepFor(entry.command, next, pid);
            try { if (await dispatch(entry)) return; } catch { /* The next prompt may have been admitted. Never replay it. */ }
            if (active.get(sessionId) === entry) stop(entry, 'unconfirmed');
        },
        onExit(sessionId: string, pid: number) {
            const entry = active.get(sessionId);
            if (!entry) return;
            const { step } = entry;
            // A real change of lead deliberately stops the source before the target starts.
            if (step.turn && step.turn.pid !== pid) return;
            if (!step.turn && step.switchesRunner && pid === step.sourcePid) return;
            if (!step.turn && deps.readRunner(sessionId)?.pid !== pid) return;
            stop(entry, 'unconfirmed');
        },
    };
}
