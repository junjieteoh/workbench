import * as React from 'react';
import type { SessionAgentTransitionQueueRequestV1, SessionAgentTransitionQueueResultV1 } from '@happier-dev/protocol';

import type { SessionAgentContinuationMachineTarget } from '@/components/sessions/agentPicker/resolveSessionAgentContinuationEligibility';
import { useRuntimeActive } from '@/hooks/runtime/useRuntimeActive';
import { sessionAgentTransitionQueueOnMachine } from '@/sync/ops/sessionAgentTransition';

export function useSessionAgentTransitionQueue(params: Readonly<{
    sessionId: string;
    accountScopeKey: string;
    machine: SessionAgentContinuationMachineTarget;
    enabled: boolean;
    activeTurnId: string | null;
}>) {
    const runtimeActive = useRuntimeActive();
    const { sessionId, accountScopeKey, machine, activeTurnId } = params;
    const enabled = params.enabled && runtimeActive && machine.machineId !== null;
    const scope = React.useMemo(() => ({ sessionId, accountScopeKey, machine }), [accountScopeKey, machine, sessionId]);
    const currentScope = React.useRef(scope);
    currentScope.current = scope;
    const requestSequence = React.useRef(0);
    const mutations = React.useRef(0);
    const readSequence = React.useRef(0);
    const [snapshot, setSnapshot] = React.useState<{
        scope: typeof scope;
        value: SessionAgentTransitionQueueResultV1;
    } | null>(null);
    const state = enabled && snapshot?.scope === scope ? snapshot.value : null;

    const request = React.useCallback(async (command: SessionAgentTransitionQueueRequestV1) => {
        if (currentScope.current !== scope || !machine.machineId || command.sessionId !== scope.sessionId) {
            throw new Error('The session changed.');
        }
        const isRead = command.action === 'get';
        const version = isRead ? requestSequence.current : ++requestSequence.current;
        const readVersion = isRead ? ++readSequence.current : 0;
        const mayPublishRead = mutations.current === 0;
        if (!isRead) mutations.current++;
        try {
            const result = await sessionAgentTransitionQueueOnMachine({ machineId: machine.machineId, serverId: machine.serverId, request: command });
            // A GET overlapping an accepted write can report the previous state.
            // Only a new read started after that write can supersede its receipt.
            if (currentScope.current === scope && version === requestSequence.current
                && (!isRead || (mayPublishRead && readVersion === readSequence.current))
                && (result.status !== 'rejected' || isRead)) {
                setSnapshot({ scope, value: result });
            }
            return result;
        } finally {
            if (!isRead) mutations.current--;
        }
    }, [machine, scope]);

    const refresh = React.useCallback(() => request({ action: 'get', sessionId }), [request, sessionId]);
    React.useEffect(() => {
        if (enabled) void refresh().catch(() => {});
    }, [activeTurnId, enabled, refresh]);

    // Other clients can schedule or cancel. Turn updates trigger an immediate read;
    // this foreground-only refresh also reflects changes that leave the turn alone.
    React.useEffect(() => {
        if (!enabled || state?.status === 'rejected') return;
        const isHandingOff = state?.status === 'dispatching' || (state?.status === 'queued' && activeTurnId !== state.turnId);
        if (!activeTurnId && !isHandingOff && state !== null) return;
        const timer = setInterval(() => { void refresh().catch(() => {}); }, isHandingOff ? 2500 : 15000);
        return () => clearInterval(timer);
    }, [activeTurnId, enabled, refresh, state]);

    return { state, request, refresh };
}
