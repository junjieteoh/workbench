import { describe, expect, it } from 'vitest';
import { SessionAgentSequenceRequestV1Schema, SessionAgentSequenceResultV1Schema } from './sessionAgentSequence.js';
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
});
