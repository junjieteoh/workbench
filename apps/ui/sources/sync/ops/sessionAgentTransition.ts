import {
    SessionAgentTransitionRequestV1Schema,
    SessionAgentTransitionQueueRequestV1Schema,
    SessionAgentTransitionQueueResultV1Schema,
    type SessionAgentTransitionQueueRequestV1,
    type SessionAgentTransitionQueueResultV1,
    SessionAgentTransitionResultV1Schema,
    beginSessionAgentTransitionEffects,
    rejectUndispatchedSessionAgentTransition,
    type SessionAgentTransitionRequestV1,
    type SessionAgentTransitionResultV1,
} from '@happier-dev/protocol';
import {
    RPC_ERROR_CODES,
    RPC_METHODS,
    SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
} from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';

/**
 * `session.agentTransition` as the UI can honestly report it.
 *
 * The daemon's result union already partitions every outcome by how far the
 * transition got, and each arm authorizes a different recovery. A transport
 * failure has to land inside that same union rather than beside it, because a
 * client that invents a second failure vocabulary immediately loses the one
 * property the union exists to preserve: whether the source runtime was
 * touched.
 *
 * Only two transport outcomes are distinguishable here:
 *
 * - `METHOD_NOT_AVAILABLE` proves the daemon has no such handler, so nothing
 *   ran. That is exactly `rejected` / `unsupported_operation`, the arm whose
 *   `sourceEffect: 'none'` promise is truthful.
 * - Everything else — timeout, aborted call, broken socket, a response this
 *   client cannot parse — proves nothing at all. The request may have been
 *   delivered and applied. That is `outcome_unknown`, and it must never be
 *   reported as a rejection that claims an untouched source.
 */

export type RunSessionAgentTransitionInput = Readonly<{
    /** The machine hosting the Session. The transition only runs there. */
    machineId: string;
    serverId: string | null;
    request: SessionAgentTransitionRequestV1;
}>;

function callSessionAgentTransition(
    input: Pick<RunSessionAgentTransitionInput, 'machineId' | 'serverId'>,
    payload: SessionAgentTransitionRequestV1 | SessionAgentTransitionQueueRequestV1,
): Promise<unknown> {
    return machineRpcWithServerScope({
        machineId: input.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.SESSION_AGENT_TRANSITION,
        payload,
        authorization: { kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE, sessionId: payload.sessionId },
    });
}

export async function sessionAgentTransitionQueueOnMachine(
    input: Pick<RunSessionAgentTransitionInput, 'machineId' | 'serverId'> & { request: SessionAgentTransitionQueueRequestV1 },
): Promise<SessionAgentTransitionQueueResultV1> {
    const payload = SessionAgentTransitionQueueRequestV1Schema.parse(input.request);
    try {
        const raw = await callSessionAgentTransition(input, payload);
        const queue = SessionAgentTransitionQueueResultV1Schema.safeParse(raw);
        if (queue.success) return queue.data;
        const olderWorker = SessionAgentTransitionResultV1Schema.safeParse(raw);
        if (olderWorker.success && olderWorker.data.type === 'rejected' && olderWorker.data.code === 'unsupported_operation') {
            return { status: 'rejected', reason: 'unsupported' };
        }
        throw new Error('Invalid response to queued agent transition');
    } catch (error) {
        if (readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) return { status: 'rejected', reason: 'unsupported' };
        throw error;
    }
}

export async function runSessionAgentTransitionOnMachine(
    input: RunSessionAgentTransitionInput,
): Promise<SessionAgentTransitionResultV1> {
    const payload = SessionAgentTransitionRequestV1Schema.parse(input.request);
    const localId = payload.input.localId;
    // Nothing here can advance the transition's effect depth — this side only
    // ever observes the daemon's answer, or fails to get one — so the client
    // holds the untouched stage for its whole life and builds every arm from
    // it. Reaching for a literal would be the one way this file could invent an
    // arm the daemon's own stages forbid.
    const effects = beginSessionAgentTransitionEffects({ localId });
    let raw: unknown;
    try {
        raw = await callSessionAgentTransition(input, payload);
    } catch (error) {
        return readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
            ? rejectUndispatchedSessionAgentTransition('unsupported_operation')
            : effects.outcomeUnknown();
    }
    const parsed = SessionAgentTransitionResultV1Schema.safeParse(raw);
    // A daemon that answered with a shape this client cannot read may well have
    // switched the Session. Claiming a no-effect rejection here would hand the
    // reader Keep editing in front of a Session that already moved.
    return parsed.success ? parsed.data : effects.outcomeUnknown();
}
