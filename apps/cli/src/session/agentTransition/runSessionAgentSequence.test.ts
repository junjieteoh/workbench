import { describe, expect, it } from 'vitest';
import { readSequencePlan } from './runSessionAgentSequence';
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
