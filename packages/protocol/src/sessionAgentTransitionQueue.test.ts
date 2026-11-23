import { describe, expect, it } from 'vitest';

import {
  SessionAgentTransitionRequestV1Schema,
  SessionAgentTransitionQueueRequestV1Schema,
  SessionAgentTransitionQueueResultV1Schema,
} from './sessionAgentTransition.js';
import { SESSION_AGENT_TRANSITION_VECTORS as vectors } from './sessionAgentTransitionVectors.js';

const transition = vectors.request.valid.minimal;
const schedule = { action: 'schedule', sessionId: transition.sessionId, turnId: 'source-turn', transition };

describe('deferred same-session agent transition', () => {
  it('preserves the selected target, instructions and exact source turn', () => {
    expect(SessionAgentTransitionQueueRequestV1Schema.parse(schedule)).toEqual(schedule);
    expect(SessionAgentTransitionQueueRequestV1Schema.safeParse({ ...schedule, turnId: '' }).success).toBe(false);
    expect(SessionAgentTransitionQueueRequestV1Schema.safeParse({ ...schedule, sessionId: 'another' }).success).toBe(false);
  });

  it('keeps queue requests disjoint from the immediate-switch wire format', () => {
    for (const command of [schedule, { action: 'get', sessionId: transition.sessionId },
      { action: 'cancel', sessionId: transition.sessionId, localId: transition.input.localId }]) {
      expect(SessionAgentTransitionQueueRequestV1Schema.safeParse(command).success).toBe(true);
      expect(SessionAgentTransitionRequestV1Schema.safeParse(command).success).toBe(false);
    }
    expect(SessionAgentTransitionQueueRequestV1Schema.safeParse(transition).success).toBe(false);
    expect(SessionAgentTransitionQueueRequestV1Schema.safeParse({ ...schedule, ...transition }).success).toBe(false);
  });

  it('reports the selected model without returning the private follow-up instructions', () => {
    const state = { status: 'queued', localId: transition.input.localId, turnId: 'source-turn',
      target: { ...transition.selection, modelId: 'chosen-model' } };
    expect(SessionAgentTransitionQueueResultV1Schema.parse(state)).toEqual(state);
    expect(SessionAgentTransitionQueueResultV1Schema.safeParse({ ...state, input: transition.input }).success).toBe(false);
  });
});
