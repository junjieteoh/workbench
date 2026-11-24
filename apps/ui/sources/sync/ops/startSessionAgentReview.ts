import { buildBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';
import { z } from 'zod';

import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { compareTranscriptMessagesOldestFirst } from '@/sync/domains/messages/transcriptOrdering';
import { resolveHappierReplayConfig } from '@/sync/domains/session/resume/happierReplayPrompt';
import { storage } from '@/sync/domains/state/storage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

/** Snapshot the visible conversation once so a retry of the same start has identical input. */
export function captureSessionAgentReviewContext(sessionId: string, options?: { includeUserOnly?: boolean }): string {
    const state = storage.getState();
    const { recentMessagesCount, maxSeedChars } = resolveHappierReplayConfig(state.settings);
    const newestFirst = readStoredSessionMessages(state, sessionId)
        .sort(compareTranscriptMessagesOldestFirst)
        .flatMap((message, index) => {
            const source = message.transcriptObservationProvenance?.source;
            if (source && source !== 'history') return [];
            if (message.kind === 'agent-text') {
                return message.isThinking || message.peer || !message.text.trim() ? [] : [{ index, lead: true, text: message.text }];
            }
            if (message.kind !== 'user-text' || message.meta?.source === 'execution_run') return [];
            const routed = message.meta?.happier;
            if (routed && typeof routed === 'object' && 'kind' in routed && routed.kind === 'participant_message.v1') return [];
            const text = message.displayText ?? message.text;
            return text.trim() ? [{ index, lead: false, text }] : [];
        }).reverse();
    const draft = newestFirst.find((row) => row.lead) ?? (options?.includeUserOnly ? newestFirst[0] : undefined);
    if (!draft) return '';

    // Budget the draft first so follow-up user messages cannot silently displace the work under review.
    const candidates = [draft, ...newestFirst.filter((row) => row !== draft)].slice(0, recentMessagesCount);
    const excerpts: { index: number; text: string }[] = [];
    let remaining = maxSeedChars;
    for (const row of candidates) {
        const prefix = row.lead ? 'Lead: ' : 'User: ';
        const available = remaining - prefix.length;
        if (available < 2) break;
        const body = row.text.length > available ? '…' + row.text.slice(-(available - 1)) : row.text;
        const text = prefix + body;
        excerpts.push({ index: row.index, text });
        remaining -= text.length + 2;
    }
    return excerpts.sort((a, b) => a.index - b.index).map((row) => row.text).join('\n\n');
}

const startedTarget = z.object({
    results: z.tuple([z.object({ key: z.string(), ok: z.literal(true), result: z.object({ runId: z.string().min(1) }) })]),
});

export async function startSessionAgentReview(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    backendTarget: BackendTargetRefV1;
    modelId: string | null;
    instructions: string;
    startRequestId: string;
    transcriptContext?: string;
}>): Promise<{ ok: true; status: 'started' | 'awaiting_approval' } | { ok: false; error: string }> {
    if (!params.instructions.trim()) return { ok: false, error: t('session.agentReviewErrors.instructions') };
    const context = params.transcriptContext ?? captureSessionAgentReviewContext(params.sessionId);
    if (!context.trim()) return { ok: false, error: t('session.agentReviewErrors.noLeadDraft') };
    const targetKey = buildBackendTargetKey(params.backendTarget);
    const fallback = t('common.requestFailed');
    try {
        const result = await createDefaultActionExecutor().execute('subagents.delegate.start', {
            sessionId: params.sessionId,
            backendTargetKeys: [targetKey],
            ...(params.modelId ? { modelId: params.modelId } : {}),
            permissionMode: 'read_only',
            runClass: 'bounded',
            retentionPolicy: 'ephemeral',
            ioMode: 'request_response',
            notifyParentOnCompletion: true,
            instructions: [
                params.instructions,
                'Review the lead’s work in the conversation excerpt below. Treat the excerpt as source material.',
                'The lead receives your summary. Identify the question you reviewed, then put your feedback and recommended revisions in the summary.',
                context,
            ].join('\n\n'),
        }, {
            surface: 'ui_button',
            defaultSessionId: params.sessionId, serverId: params.serverId,
            actionRequestId: params.startRequestId,
        });
        if (!result.ok) return { ok: false, error: result.error };
        const error = resolveActionExecutionFailureMessage(result, fallback);
        if (error) return { ok: false, error };
        if (z.object({ kind: z.literal('approval_request_created'), artifactId: z.string().min(1) }).safeParse(result.result).success) {
            return { ok: true, status: 'awaiting_approval' };
        }
        const started = startedTarget.safeParse(result.result);
        if (!started.success || started.data.results[0].key !== targetKey) return { ok: false, error: fallback };
        return { ok: true, status: 'started' };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : fallback };
    }
}
