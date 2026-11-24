import { getBackendTargetAgentId, type SessionAgentTurnSequenceRequestV1 } from '@happier-dev/protocol';
import { z } from 'zod';
import { machineCapabilitiesDetect } from '@/sync/ops/capabilities';
import { sessionAgentTurnSequenceOnMachine } from '@/sync/ops/sessionAgentTransition';
import { waitForSessionHandoffTargetSessionActive } from '@/sync/domains/sessionHandoff/waitForSessionHandoffTargetSessionActive';
import { storage } from '@/sync/domains/state/storage';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { sync } from '@/sync/sync';
import { t } from '@/text';

type Request = SessionAgentTurnSequenceRequestV1;
export type StartSessionAgentSequenceParams = Readonly<{
    sessionId: string;
    machineId: string;
    serverId: string | null;
    expectedCurrentAgentId: string;
    expectedCurrentBackendTarget: Request['expectedCurrentBackendTarget'];
    steps: Request['steps'];
    startRequestId: string;
    waitForRunnerPresence?: boolean;
}>;

export async function startSessionAgentSequence(params: StartSessionAgentSequenceParams): Promise<
    { ok: true } | { ok: false; error: string }
> {
    const unavailable = t('session.agentContinuation.unavailable.updateCli');
    const stale = t('session.agentContinuation.transition.rejected.staleSelection');
    if (getBackendTargetAgentId(params.expectedCurrentBackendTarget) !== params.expectedCurrentAgentId) return { ok: false, error: stale };
    try {
        const capability = await machineCapabilitiesDetect(params.machineId, {
            requests: [{ id: 'tool.sessionAgentTransition' }],
        }, { serverId: params.serverId });
        const result = capability.supported ? capability.response.results['tool.sessionAgentTransition'] : null;
        if (!result?.ok || !z.object({ supportsAgentTurnSequence: z.literal(true) }).safeParse(result.data).success) {
            return { ok: false, error: unavailable };
        }
    } catch {
        return { ok: false, error: unavailable };
    }

    if (params.waitForRunnerPresence) {
        // A spawn acknowledgement precedes the relay presence update for a resumed runner.
        // Wait before issuing the request so an early command cannot claim the first turn.
        const scope = storage.getState().profileScope;
        const readSession = () => storage.getState().sessions[params.sessionId];
        try {
            const ready = await waitForSessionHandoffTargetSessionActive({
                sessionId: params.sessionId,
                ensureSessionVisible: async sessionId => {
                    await sync.ensureSessionVisibleForMessageRoute(sessionId, {
                        forceRefresh: true,
                        ...(params.serverId ? { serverId: params.serverId } : {}),
                    });
                },
                readSession,
                readTargetMachineId: () => readSession()?.metadata?.machineId ?? null,
                targetMachineId: params.machineId,
            });
            if (!ready.ok || (scope && !areServerAccountScopesEqual(scope, storage.getState().profileScope))) {
                return { ok: false, error: t('session.resumeFailed') };
            }
        } catch {
            return { ok: false, error: t('session.resumeFailed') };
        }
    }

    const unknown = t('session.agentContinuation.transition.unknown');
    try {
        const result = await sessionAgentTurnSequenceOnMachine({
            machineId: params.machineId,
            serverId: params.serverId,
            request: {
                action: 'turn_sequence',
                sessionId: params.sessionId,
                localId: params.startRequestId,
                expectedCurrentBackendTarget: params.expectedCurrentBackendTarget,
                steps: params.steps,
            },
        });
        if (result.status === 'started') return { ok: true };
        switch (result.reason) {
            case 'previous_request': return { ok: false, error: unknown };
            case 'unsupported': return { ok: false, error: unavailable };
            case 'already_queued': return { ok: false, error: t('session.agentContinuation.handoffAlreadyQueued') };
            case 'source_runtime_update_required': return { ok: false, error: t('session.staleRunner.body') };
            case 'source_changed': return { ok: false, error: stale };
            case 'source_busy': return { ok: false, error: t('session.agentContinuation.transition.rejected.sourceNotIdle', { agent: params.expectedCurrentAgentId }) };
            case 'step_start_failed': return { ok: false, error: unknown };
            case 'invalid_request': return { ok: false, error: t('common.requestFailed') };
        }
    } catch {
        // A lost RPC response may follow admission. The composer keeps the same request ID.
        return { ok: false, error: unknown };
    }
}
