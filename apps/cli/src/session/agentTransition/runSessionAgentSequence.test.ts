import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionAgentTurnSequenceRequestV1Schema, type SessionAgentTransitionRequestV1 } from '@happier-dev/protocol';
import * as sessionMessages from '@/session/services/sendSessionMessage';
import * as claims from './sessionAgentSequence';
import { createNativeForegroundTurnSequence, readSequencePlan } from './runSessionAgentSequence';
const target = { kind: 'configuredAcpBackend', backendId: 'writer' } as const;
const state = {
    runId: 'run-7', callId: 'call-7', sidechainId: 'side-7', intent: 'plan',
    backendTarget: target, permissionMode: 'read_only', retentionPolicy: 'ephemeral',
    runClass: 'bounded', ioMode: 'request_response', status: 'succeeded', startedAtMs: 1,
};
const payload = {
    runRef: { runId: state.runId, callId: state.callId, backendId: 'customAcp', backendTarget: target },
    summary: 'Collect requirements.', sections: [{ title: 'Launch', items: ['Show the green exhibit.'] }],
    risks: ['Wrong audience.'], milestones: [{ title: 'Preview', details: 'Invite reviewers.' }], generatedAtMs: 2,
};
const snapshot = { run: state, structuredMeta: { kind: 'plan_output.v1', payload } };
describe('readSequencePlan', () => {
    it('retains the finished plan, execution steps, risks and milestones', () => {
        expect(JSON.parse(readSequencePlan(snapshot, state.runId, target)!)).toEqual({
            summary: payload.summary, sections: payload.sections, risks: payload.risks, milestones: payload.milestones,
        });
    });
    it('refuses a result from a different run, target, intent or a failed execution', () => {
        for (const delta of [{ intent: 'delegate' }, { backendTarget: { kind: 'builtInAgent', agentId: 'codex' } }, { status: 'failed' }, { runId: 'other' }]) {
            expect(readSequencePlan({ ...snapshot, run: { ...state, ...delta } }, state.runId, target)).toBeNull();
        }
        expect(readSequencePlan({ ...snapshot, structuredMeta: { kind: 'plan_output.v1', payload: { ...payload, runRef: { ...payload.runRef, runId: 'other' } } } }, state.runId, target)).toBeNull();
    });
});


describe('one addressed foreground turn', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each(['same', 'different'] as const)('admits exactly one turn on the %s backend with the selected model', async backend => {
        vi.spyOn(claims, 'claimSessionAgentSequence').mockResolvedValue(true);
        const send = vi.spyOn(sessionMessages, 'sendSessionMessage').mockImplementation(async args => ({
            ok: true, sessionId: args.idOrPrefix, localId: args.localId!, waited: false,
        }));
        const transition = vi.fn(async (_request: SessionAgentTransitionRequestV1) => true);
        const runner = { pid: 42, activeTurnId: null as string | null, supportsInPlaceSequence: true };
        const owner = createNativeForegroundTurnSequence({
            credentials: { token: 'test', encryption: null }, readRunner: () => runner, transition,
        });
        const current = { kind: 'builtInAgent', agentId: 'claude' };
        const successor = backend === 'same' ? current : target;
        const step = { backendTarget: successor, modelId: 'requested-model', instructions: 'Review the Q3 draft.' };
        const request = SessionAgentTurnSequenceRequestV1Schema.parse({
            action: 'turn_sequence', sessionId: 's1', localId: 'single-input', expectedCurrentBackendTarget: current, steps: [step],
        });

        expect(await Promise.all([owner.start(request), owner.start(request)])).toEqual([{ status: 'started' }, { status: 'started' }]);
        const inputId = send.mock.calls[0]?.[0].localId ?? transition.mock.calls[0]?.[0].input.localId;
        expect(inputId).toBeTruthy();
        if (backend === 'same') {
            expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
                idOrPrefix: 's1', localId: inputId, modelOverride: step.modelId, message: step.instructions,
                resumeInactiveSession: false, pendingAdmissionMode: 'continuation_if_no_queued_user_input',
            }));
            expect(transition).not.toHaveBeenCalled();
        } else {
            expect(transition).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
                sessionId: 's1', expectedCurrentBackendTarget: current,
                selection: expect.objectContaining({ backendTarget: successor, modelId: step.modelId }),
                input: expect.objectContaining({ localId: inputId, text: step.instructions }),
            }), expect.any(Function));
            expect(send).not.toHaveBeenCalled();
            runner.pid = 43;
        }
        owner.onInput('s1', inputId);
        runner.activeTurnId = 'addressed-turn';
        owner.onBegin('s1', runner.pid, 'addressed-turn', [inputId!]);
        runner.activeTurnId = null;
        await owner.onTerminal('s1', runner.pid, 'addressed-turn', true);
        expect(owner.isActive('s1')).toBe(false);
        expect(await owner.start(request)).toEqual({ status: 'started' });
        expect(send.mock.calls.length + transition.mock.calls.length).toBe(1);
    });
});
