import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createProtectedLocalStateFileExclusive } from '@/utils/fs/protectedLocalState';
import { fingerprintExecutionRunStartRequest } from '@/agent/executionRuns/executionRunStartFingerprint';
import type { SessionAgentSequenceRequestV1, SessionAgentSequenceResultV1, ExecutionRunStartResponse } from '@happier-dev/protocol';

type Request = SessionAgentSequenceRequestV1;
type Receipt = Pick<ExecutionRunStartResponse, 'runId' | 'callId' | 'sidechainId'>;
type Runner = Readonly<{ pid: number; activeTurnId: string | null }>;
type Failure = 'plan_failed' | 'source_changed' | 'handoff_unconfirmed';
type Entry = { fingerprint: string; receipt: Promise<SessionAgentSequenceResultV1> };

// A daemon restart disarms observers. A retry cannot accidentally commission the same planner again.
export async function claimSessionAgentSequence(directory: string, command: Pick<Request, 'sessionId' | 'localId'>): Promise<boolean> {
    const key = createHash('sha256').update(JSON.stringify([command.sessionId, command.localId])).digest('hex');
    try {
        await createProtectedLocalStateFileExclusive(join(directory, key), '');
        return true;
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return false;
        throw error;
    }
}

export function createSessionAgentSequenceCoordinator(deps: Readonly<{
    readRunner: (sessionId: string) => Runner | null;
    claim: (command: Request) => Promise<boolean>;
    start: (command: Request) => Promise<Receipt | null>;
    wait: (command: Request, runId: string) => Promise<string | null>;
    deliver: (command: Request, plan: string, canDeliver: () => boolean) => Promise<boolean>;
    failed: (command: Request, reason: Failure) => Promise<void> | void;
}>) {
    const receipts = new Map<string, Entry>();
    const active = new Map<string, { superseded: boolean }>();

    function start(command: Request): Promise<SessionAgentSequenceResultV1> {
        const { sessionId, localId } = command;
        const key = JSON.stringify([sessionId, localId]);
        const fingerprint = fingerprintExecutionRunStartRequest(command);
        const previous = receipts.get(key);
        if (previous) return fingerprint === previous.fingerprint ? previous.receipt
            : Promise.resolve({ status: 'rejected', reason: 'invalid_request' });
        if (active.has(sessionId)) return Promise.resolve({ status: 'rejected', reason: 'already_queued' });
        const runner = deps.readRunner(sessionId);
        if (!runner || runner.activeTurnId !== null) return Promise.resolve({ status: 'rejected', reason: 'source_busy' });

        const expectedPid = runner.pid;
        const entry = { superseded: false };
        active.set(sessionId, entry);
        const canDeliver = () => {
            const current = deps.readRunner(sessionId);
            return !entry.superseded && current?.pid === expectedPid && current.activeTurnId === null;
        };

        async function finish(runId: string): Promise<void> {
            let failure: Failure | null = 'plan_failed';
            try {
                const plan = await deps.wait(command, runId);
                if (!plan) return;
                failure = 'source_changed';
                if (!canDeliver()) return;
                failure = 'handoff_unconfirmed';
                if (await deps.deliver(command, plan, canDeliver)) failure = null;
            } finally {
                active.delete(sessionId);
                if (failure) await deps.failed(command, failure);
            }
        }

        const receipt = Promise.resolve().then(async (): Promise<SessionAgentSequenceResultV1> => {
            try {
                if (!canDeliver()) {
                    active.delete(sessionId);
                    return { status: 'rejected', reason: 'source_changed' };
                }
                if (!(await deps.claim(command))) {
                    active.delete(sessionId);
                    return { status: 'rejected', reason: 'previous_request' };
                }
                const result = await deps.start(command);
                if (result) {
                    void finish(result.runId).catch(() => {}); // finish publishes a failure notice before releasing its observer.
                    return { status: 'started', ...result };
                }
            } catch { /* The call may have reached the planner. Do not repeat the start automatically. */ }
            active.delete(sessionId);
            return { status: 'rejected', reason: 'plan_start_failed' };
        });
        receipts.set(key, { fingerprint, receipt });
        return receipt;
    }

    return { start, onParentTurnStarted(sessionId: string) {
        const entry = active.get(sessionId);
        if (entry) entry.superseded = true;
    } };
}
