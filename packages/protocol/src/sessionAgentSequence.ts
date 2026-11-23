import { z } from 'zod';

import { BackendTargetRefSchema } from './backendTargets/backendTargetRef.js';
import { lazySchema } from './lazySchema.js';
import { PendingLocalIdSchema } from './sessionMessages/pendingLocalId.js';

const SequenceStepV1Schema = lazySchema(() => z.strictObject({
    backendTarget: BackendTargetRefSchema,
    modelId: z.string().trim().min(1).max(256).nullable(),
    instructions: z.string().trim().min(1),
}));

export const SessionAgentSequenceContinuationV1Schema = lazySchema(() => z.strictObject({
    machineId: z.string().trim().min(1),
    localId: PendingLocalIdSchema,
    expectedCurrentBackendTarget: BackendTargetRefSchema,
    successor: SequenceStepV1Schema,
}));

// Older session.agentTransition handlers reject this disjoint action before dispatch.
export const SessionAgentSequenceRequestV1Schema = lazySchema(() => z.strictObject({
    action: z.literal('sequence'),
    sessionId: z.string().trim().min(1),
    localId: PendingLocalIdSchema,
    expectedCurrentBackendTarget: BackendTargetRefSchema,
    planner: SequenceStepV1Schema,
    successor: SequenceStepV1Schema,
}));
export type SessionAgentSequenceRequestV1 = z.infer<typeof SessionAgentSequenceRequestV1Schema>;

export const SessionAgentSequenceResultV1Schema = lazySchema(() => z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('started'), runId: z.string().min(1), callId: z.string().min(1), sidechainId: z.string().min(1) }),
    z.strictObject({ status: z.literal('rejected'), reason: z.enum([
        'unsupported', 'invalid_request', 'already_queued', 'source_busy', 'source_changed', 'plan_start_failed', 'previous_request',
    ]) }),
]));
export type SessionAgentSequenceResultV1 = z.infer<typeof SessionAgentSequenceResultV1Schema>;
