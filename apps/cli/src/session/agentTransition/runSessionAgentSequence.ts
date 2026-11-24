import { join } from 'node:path';
import { configuration } from '@/configuration';
import {
    buildBackendTargetKey,
    getBackendTargetAgentId,
    ExecutionRunGetResponseSchema,
    ExecutionRunStartResponseSchema,
    PlanOutputV1Schema,
    type BackendTargetRefV1,
    type SessionAgentSequenceRequestV1,
    type SessionAgentTurnSequenceRequestV1,
    type SessionAgentTransitionRequestV1,
} from '@happier-dev/protocol';
import { resolveSessionPersistedRuntimeIdentity } from '@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import type { Credentials } from '@/persistence';
import { startExecutionRun, waitForExecutionRun } from '@/session/services/executionRuns';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { logger } from '@/ui/logger';

import { createForegroundTurnSequence } from './sessionAgentTurnSequence';
import { claimSessionAgentSequence, createSessionAgentSequenceCoordinator } from './sessionAgentSequence';

type Request = SessionAgentSequenceRequestV1;

function matchesSource(metadata: unknown, target: BackendTargetRefV1): boolean {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
    const identity = resolveSessionPersistedRuntimeIdentity(metadata as Record<string, unknown>);
    return !!identity && buildBackendTargetKey(identity.backendTarget) === buildBackendTargetKey(target);
}

export function readSequencePlan(result: unknown, runId: string, target: BackendTargetRefV1): string | null {
    const run = ExecutionRunGetResponseSchema.safeParse(result);
    if (!run.success) return null;
    const state = run.data.run;
    const targetKey = buildBackendTargetKey(target);
    if (state.runId !== runId || state.status !== 'succeeded' || state.intent !== 'plan'
        || buildBackendTargetKey(state.backendTarget) !== targetKey || run.data.structuredMeta?.kind !== 'plan_output.v1') return null;
    const output = PlanOutputV1Schema.safeParse(run.data.structuredMeta.payload);
    if (!output.success || output.data.runRef.runId !== runId) return null;
    const backend = output.data.runRef.backendTarget;
    if (!backend || buildBackendTargetKey(backend) !== targetKey) return null;
    const { summary, sections, risks, milestones } = output.data;
    return JSON.stringify({ summary, sections, risks, milestones });
}

type NativeSequenceDependencies = Readonly<{
    credentials: Credentials;
    readRunner: (sessionId: string) => { pid: number; activeTurnId: string | null } | null;
    transition: (request: SessionAgentTransitionRequestV1, canStopSource: () => boolean) => Promise<boolean>;
}>;

async function deliverNativeForegroundInput(params: NativeSequenceDependencies, input: Readonly<{
    sessionId: string; localId: string; text: string; expectedCurrentBackendTarget: BackendTargetRefV1; successor: Request['successor'];
}>, canDeliver: () => boolean): Promise<boolean> {
    const { credentials } = params;
    const { successor, expectedCurrentBackendTarget, sessionId, localId, text } = input;
    if (buildBackendTargetKey(successor.backendTarget) === buildBackendTargetKey(expectedCurrentBackendTarget)) {
        const sent = await sendSessionMessage({
            credentials, idOrPrefix: sessionId, message: text, localId, wait: false, timeoutMs: 30_000,
            resumeInactiveSession: false, modelOverride: successor.modelId,
            pendingAdmissionMode: 'continuation_if_no_queued_user_input',
            canAdmit: ({ rawSession, metadata }) => canDeliver() && rawSession.active === true && matchesSource(metadata, expectedCurrentBackendTarget),
        });
        return sent.ok && !sent.suppressed;
    }
    return params.transition({
        v: 1, sessionId, expectedCurrentAgentId: getBackendTargetAgentId(expectedCurrentBackendTarget), expectedCurrentBackendTarget,
        selection: { v: 1, agentId: getBackendTargetAgentId(successor.backendTarget), backendTarget: successor.backendTarget,
            ...(successor.modelId ? { modelId: successor.modelId } : {}) },
        input: { text, localId, meta: { displayText: successor.instructions } },
    }, canDeliver);
}

export function createNativeSessionAgentSequence(params: NativeSequenceDependencies) {
    const { credentials } = params;
    const readContext = async (command: Request) => {
        const target = await resolveSessionTransportContext({ credentials, idOrPrefix: command.sessionId });
        if (!target.ok || target.sessionId !== command.sessionId || target.rawSession.active !== true || target.rawSession.archivedAt != null) return null;
        if (!matchesSource(tryDecryptSessionMetadata({ credentials, rawSession: target.rawSession }), command.expectedCurrentBackendTarget)) return null;
        return { token: credentials.token, sessionId: target.sessionId, ctx: target.ctx, mode: target.mode };
    };
    return createSessionAgentSequenceCoordinator({
        readRunner: params.readRunner,
        claim: command => claimSessionAgentSequence(join(configuration.activeServerDir, 'agent-sequence-claims'), command),
        start: async command => {
            const context = await readContext(command);
            if (!context) return null;
            const result = await startExecutionRun({ ...context, request: {
                startRequestId: command.localId,
                intent: 'plan', backendTarget: command.planner.backendTarget, instructions: command.planner.instructions,
                ...(command.planner.modelId ? { modelId: command.planner.modelId } : {}),
                runClass: 'bounded', retentionPolicy: 'ephemeral', permissionMode: 'read_only', ioMode: 'request_response',
                notifyParentOnCompletion: false, launchOrigin: { kind: 'session', sessionId: command.sessionId },
            } });
            const receipt = result.ok && ExecutionRunStartResponseSchema.safeParse(result.data);
            if (!receipt || !receipt.success) return null;
            const { runId, callId, sidechainId } = receipt.data;
            return { runId, callId, sidechainId };
        },
        wait: async (command, runId) => {
            const context = await readContext(command);
            if (!context) return null;
            const result = await waitForExecutionRun({ ...context, runId, timeoutMs: null });
            return result.ok && result.status === 'succeeded' ? readSequencePlan(result.result, runId, command.planner.backendTarget) : null;
        },
        deliver: async (command, plan, canDeliver) => {
            const { successor, expectedCurrentBackendTarget, sessionId, localId } = command;
            const text = [successor.instructions, 'The selected planner produced the following plan. Use it as reference for the requested work.', plan].join('\n\n');
            return await deliverNativeForegroundInput(params, { successor, expectedCurrentBackendTarget, sessionId, localId, text }, canDeliver);
        },
        failed: async (command, reason) => {
            const messages = {
                plan_failed: 'The planner did not return a completed plan. The handoff stopped.',
                source_changed: 'The session changed during planning. The handoff stopped.',
                handoff_unconfirmed: 'The handoff could not confirm delivery to the selected agent. Check the thread before retrying.',
            };
            const attempt = await sendSessionMessage({
                credentials, idOrPrefix: command.sessionId, kind: 'notice', from: 'Agent handoff', message: messages[reason],
                localId: 'sequence-notice-' + command.localId, wait: false, timeoutMs: 30_000,
            });
            if (!attempt.ok) logger.warn('[AGENT SEQUENCE] Could not publish outcome', { sessionId: command.sessionId, reason });
        },
    });
}


export function createNativeForegroundTurnSequence(params: NativeSequenceDependencies) {
    return createForegroundTurnSequence({
        readRunner: params.readRunner,
        claim: command => claimSessionAgentSequence(join(configuration.activeServerDir, 'agent-sequence-claims'), command),
        dispatch(command: SessionAgentTurnSequenceRequestV1, index, localId, guard) {
            const successor = command.steps[index]!;
            return deliverNativeForegroundInput(params, {
                successor, localId, sessionId: command.sessionId, text: successor.instructions,
                expectedCurrentBackendTarget: command.steps[index - 1]?.backendTarget ?? command.expectedCurrentBackendTarget,
            }, guard);
        },
        async stopped(command, reason, index) {
            const detail = {
                interrupted: 'You or another session took over.',
                failed: 'The current turn was cancelled or failed.',
                unconfirmed: 'The worker could not confirm this turn or delivery to the next agent.',
            }[reason];
            const result = await sendSessionMessage({
                credentials: params.credentials, idOrPrefix: command.sessionId, kind: 'notice', from: 'Agent sequence',
                message: 'Sequence stopped at step ' + (index + 1) + '. ' + detail,
                localId: 'sequence-notice-' + command.localId, wait: false, timeoutMs: 30_000,
            });
            if (!result.ok) logger.warn('[AGENT SEQUENCE] Could not publish stop notice', { sessionId: command.sessionId, reason });
        },
    });
}
