import { describe, expect, it } from 'vitest';
import {
    SessionAgentSequenceRequestV1Schema, SessionAgentSequenceResultV1Schema,
    SessionAgentTurnSequenceRequestV1Schema, SessionAgentTurnSequenceResultV1Schema,
} from './sessionAgentSequence.js';
import { SessionAgentTransitionQueueRequestV1Schema, SessionAgentTransitionRequestV1Schema } from './sessionAgentTransition.js';
const agent = { kind: 'builtInAgent', agentId: 'claude' };
const step = { backendTarget: agent, modelId: null, instructions: 'Do the work.' };
const request = { action: 'sequence', localId: 'request-1', sessionId: 'session-1', expectedCurrentBackendTarget: agent, planner: step, successor: step };
describe('session agent sequence', () => {
    it('validates exactly two addressed steps, preserving each chosen provider and model', () => {
        expect(SessionAgentSequenceRequestV1Schema.parse(request)).toEqual(request);
        expect(SessionAgentSequenceRequestV1Schema.safeParse({ ...request, planner: { ...step, instructions: ' ' } }).success).toBe(false);
        expect(SessionAgentSequenceRequestV1Schema.safeParse({ ...request, extra: true }).success).toBe(false);
        expect(SessionAgentTransitionQueueRequestV1Schema.safeParse(request).success).toBe(false);
        expect(SessionAgentTransitionRequestV1Schema.safeParse(request).success).toBe(false);
    });
    it('requires proof that the planner started before reporting admission', () => {
        expect(SessionAgentSequenceResultV1Schema.safeParse({ status: 'started' }).success).toBe(false);
        expect(SessionAgentSequenceResultV1Schema.safeParse({ status: 'started', runId: 'r', callId: 'c', sidechainId: 's' }).success).toBe(true);
    });

    it('accepts repeated agents in an ordered list and keeps the foreground request disjoint from existing operations', () => {
        const foreground = {
            action: 'turn_sequence', localId: 'request-2', sessionId: 'session-1', expectedCurrentBackendTarget: agent,
            steps: [step, { ...step, backendTarget: { kind: 'builtInAgent', agentId: 'gemini' } }, { ...step, modelId: 'other' }],
        };
        expect(SessionAgentTurnSequenceRequestV1Schema.parse(foreground)).toEqual(foreground);
        expect(SessionAgentTurnSequenceRequestV1Schema.safeParse({ ...foreground, steps: [step] }).success).toBe(false);
        expect(SessionAgentSequenceRequestV1Schema.safeParse(foreground).success).toBe(false);
        expect(SessionAgentTransitionRequestV1Schema.safeParse(foreground).success).toBe(false);
        expect(SessionAgentTransitionQueueRequestV1Schema.safeParse(foreground).success).toBe(false);
        expect(SessionAgentTurnSequenceResultV1Schema.parse({ status: 'started' })).toEqual({ status: 'started' });
    });
});
