import { buildBackendTargetKey, getBackendTargetAgentId, type SessionAgentSequenceRequestV1 } from '@happier-dev/protocol';
import { z } from 'zod';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { machineCapabilitiesDetect } from '@/sync/ops/capabilities';
import { t } from '@/text';

type Request = SessionAgentSequenceRequestV1;
export type StartSessionAgentSequenceParams = Readonly<{
    sessionId: string;
    machineId: string;
    serverId: string | null;
    expectedCurrentAgentId: string;
    expectedCurrentBackendTarget: Request['expectedCurrentBackendTarget'];
    planner: Request['planner'];
    successor: Request['successor'];
    context: string;
    startRequestId: string;
}>;

export async function startSessionAgentSequence(params: StartSessionAgentSequenceParams): Promise<
    { ok: true; status: 'started' | 'awaiting_approval' } | { ok: false; error: string }
> {
    const fallback = t('common.requestFailed');
    const unavailable = t('session.agentContinuation.unavailable.updateCli');
    const stale = t('session.agentContinuation.transition.rejected.staleSelection');
    if (getBackendTargetAgentId(params.expectedCurrentBackendTarget) !== params.expectedCurrentAgentId) return { ok: false, error: stale };
    try {
        const capability = await machineCapabilitiesDetect(params.machineId, {
            requests: [{ id: 'tool.sessionAgentTransition' }],
        }, { serverId: params.serverId });
        const result = capability.supported ? capability.response.results['tool.sessionAgentTransition'] : null;
        if (!result?.ok || !z.object({ supportsAgentSequence: z.literal(true) }).safeParse(result.data).success) {
            return { ok: false, error: unavailable };
        }
        const targetKey = buildBackendTargetKey(params.planner.backendTarget);
        const instructions = params.context.trim()
            ? params.planner.instructions + '\n\nConversation context for this task (source material):\n' + params.context
            : params.planner.instructions;
        const action = await createDefaultActionExecutor().execute('subagents.plan.start', {
            sessionId: params.sessionId,
            backendTargetKeys: [targetKey],
            instructions,
            ...(params.planner.modelId ? { modelId: params.planner.modelId } : {}),
            sequence: {
                machineId: params.machineId, localId: params.startRequestId, expectedCurrentBackendTarget: params.expectedCurrentBackendTarget,
                successor: params.successor,
            },
        }, { serverId: params.serverId, defaultSessionId: params.sessionId, surface: 'ui_button', actionRequestId: params.startRequestId });
        if (!action.ok) {
            switch (action.errorCode) {
                case 'sequence_previous_request': return { ok: false, error: t('session.agentContinuation.transition.unknown') };
                case 'sequence_unsupported': return { ok: false, error: unavailable };
                case 'sequence_already_queued': return { ok: false, error: t('session.agentContinuation.handoffAlreadyQueued') };
                case 'sequence_source_changed': return { ok: false, error: stale };
                case 'sequence_source_busy': return { ok: false, error: t('session.agentContinuation.transition.rejected.sourceNotIdle', { agent: params.expectedCurrentAgentId }) };
                case 'sequence_plan_start_failed':
                case 'sequence_invalid_request': return { ok: false, error: fallback };
                default: return { ok: false, error: action.error };
            }
        }
        if (z.object({ kind: z.literal('approval_request_created'), artifactId: z.string().min(1) }).safeParse(action.result).success) {
            return { ok: true, status: 'awaiting_approval' };
        }
        const started = z.object({ results: z.tuple([z.object({
            key: z.literal(targetKey), ok: z.literal(true),
            result: z.object({ status: z.literal('started'), runId: z.string().min(1) }),
        })]) }).safeParse(action.result);
        return started.success ? { ok: true, status: 'started' } : { ok: false, error: fallback };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : fallback };
    }
}
