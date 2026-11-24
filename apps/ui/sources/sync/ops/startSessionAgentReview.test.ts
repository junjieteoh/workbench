import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionsSettingsV1Schema, isActionEnabledByActionsSettings } from '@happier-dev/protocol';

import type { Message } from '@/sync/domains/messages/messageTypes';

const { execute, getState } = vi.hoisted(() => ({ execute: vi.fn(), getState: vi.fn() }));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({ createDefaultActionExecutor: () => ({ execute }) }));
vi.mock('@/sync/domains/state/storage', () => ({ storage: { getState } }));

import { captureSessionAgentReviewContext, startSessionAgentReview } from './startSessionAgentReview';

function agent(text: string, seq: number): Message {
    return { kind: 'agent-text', id: String(seq), localId: null, createdAt: seq, seq, text };
}

const params = {
    sessionId: 'source', serverId: 'private', backendTarget: { kind: 'configuredAcpBackend', backendId: 'peer-1' },
    modelId: 'selected-model', instructions: 'Check the forecast assumptions.', startRequestId: 'request-1',
} as const;

describe('startSessionAgentReview', () => {
    beforeEach(() => {
        execute.mockReset();
        execute.mockResolvedValue({ ok: true, result: { results: [{ key: 'acpBackend:peer-1', ok: true, result: { runId: 'r' } }] } });
        getState.mockReturnValue({ settings: {}, sessionMessages: {
            source: { messages: [
                agent('Latest lead draft.', 3),
                { ...agent('Private reasoning.', 4), isThinking: true },
                { ...agent('Peer message.', 5), peer: { name: 'Other', handback: true } },
                { ...agent('User asked for a forecast.', 1), kind: 'user-text' },
                { ...agent('internal notification', 6), kind: 'user-text', meta: { source: 'execution_run' } },
                { ...agent('Ask about the cited file.', 2), kind: 'user-text', meta: { happierStructuredInputV1: { v: 1, mentions: [] } } },
                { ...agent('Routed to teammate only.', 7), kind: 'user-text', meta: { happier: { kind: 'participant_message.v1' } } },
            ] },
            other: { messages: [agent('Different conversation.', 2)] },
        } });
    });

    it('sends the selected backend the visible source conversation in transcript order and returns the result to its lead', async () => {
        await expect(startSessionAgentReview(params)).resolves.toEqual({ ok: true, status: 'started' });
        expect(execute).toHaveBeenCalledWith('subagents.delegate.start', expect.objectContaining({
            sessionId: 'source', backendTargetKeys: ['acpBackend:peer-1'], modelId: 'selected-model',
            submittedInstruction: params.instructions, notifyParentOnCompletion: true, permissionMode: 'read_only', runClass: 'bounded',
        }), expect.objectContaining({ serverId: 'private', actionRequestId: 'request-1', surface: 'ui_button' }));
        const request = execute.mock.calls[0]![1];
        expect(request.instructions).toContain('Check the forecast assumptions.');
        expect(request.instructions).toMatch(/User asked for a forecast\.[\s\S]+Latest lead draft\./);
        expect(request.instructions).toContain('Ask about the cited file.');
        expect(request.instructions).not.toMatch(/Private reasoning|Different conversation|Peer message|internal notification|Routed to teammate/);
    });

    it('allows an explicit mention with default shortcut settings and respects disabled UI actions', async () => {
        await startSessionAgentReview(params);
        const [action, , context] = execute.mock.calls[0]!;
        expect(isActionEnabledByActionsSettings(action, ActionsSettingsV1Schema.parse({ v: 1, actions: {} }), context)).toBe(true);
        const disabled = ActionsSettingsV1Schema.parse({ v: 1, actions: { [action]: { disabledSurfaces: ['ui_button'] } } });
        expect(isActionEnabledByActionsSettings(action, disabled, context)).toBe(false);
    });

    it('pins identical input on retry even after more draft text has arrived, and omits the default model', async () => {
        const snapshot = captureSessionAgentReviewContext('source');
        const attempt = { ...params, modelId: null, transcriptContext: snapshot };
        await startSessionAgentReview(attempt);
        getState.mockReturnValue({ settings: {}, sessionMessages: {} });
        await startSessionAgentReview(attempt);
        expect(execute.mock.calls[0]).toEqual(execute.mock.calls[1]);
        expect(execute.mock.calls[0]![1]).not.toHaveProperty('modelId');
    });

    it('can seed a planner with a user brief before the first agent reply', () => {
        getState.mockReturnValue({ settings: {}, sessionMessages: { source: { messages: [
            { ...agent('Design the launch report.', 1), kind: 'user-text' },
        ] } } });
        expect(captureSessionAgentReviewContext('source')).toBe('');
        expect(captureSessionAgentReviewContext('source', { includeUserOnly: true })).toBe('User: Design the launch report.');
    });

    it('requires a visible lead draft, bounds the recent excerpt, and forwards no other session when missing', async () => {
        expect(captureSessionAgentReviewContext('missing')).toBe('');
        getState.mockReturnValue({ settings: { sessionReplayMaxSeedChars: 1024 }, sessionMessages: { source: {
            messages: [agent('Old version.', 1), agent('A'.repeat(2200) + 'closing sentence.', 2)],
        } } });
        const context = captureSessionAgentReviewContext('source');
        expect(context.length).toBeLessThanOrEqual(1024);
        expect(context).toContain('closing sentence.');
        expect(context).not.toContain('Old version.');
        await expect(startSessionAgentReview({ ...params, sessionId: 'missing' })).resolves.toMatchObject({ ok: false });
        expect(execute).not.toHaveBeenCalled();
    });

    it.each([
        [{ ok: false, error: 'Disabled' }, { ok: false, error: 'Disabled' }],
        [{ ok: true, result: { results: [{ key: 'acpBackend:peer-1', ok: false, error: 'Unavailable' }] } }, { ok: false, error: 'Unavailable' }],
        [{ ok: true, result: { kind: 'approval_request_created', artifactId: 'a' } }, { ok: true, status: 'awaiting_approval' }],
    ])('reports the native launch or approval outcome', async (reply, expected) => {
        execute.mockResolvedValue(reply);
        await expect(startSessionAgentReview(params)).resolves.toEqual(expected);
    });

    it('rejects a response for a different backend', async () => {
        execute.mockResolvedValue({ ok: true, result: { results: [{ key: 'agent:other', ok: true, result: { runId: 'r' } }] } });
        await expect(startSessionAgentReview(params)).resolves.toMatchObject({ ok: false });
    });

    it('requires the user’s review instructions before executing the delegation', async () => {
        await expect(startSessionAgentReview({ ...params, instructions: '  ' })).resolves.toMatchObject({ ok: false });
        expect(execute).not.toHaveBeenCalled();
    });

    it('preserves the draft even when a later user message exceeds the context budget', () => {
        getState.mockReturnValue({ settings: { sessionReplayMaxSeedChars: 1024 }, sessionMessages: { source: {
            messages: [agent('Draft discussing inventory.', 1), { ...agent('A'.repeat(1800) + 'additional context', 2), kind: 'user-text' }],
        } } });
        const context = captureSessionAgentReviewContext('source');
        expect(context.length).toBeLessThanOrEqual(1024);
        expect(context).toMatch(/Draft discussing inventory\.[\s\S]+additional context/);
    });
});
