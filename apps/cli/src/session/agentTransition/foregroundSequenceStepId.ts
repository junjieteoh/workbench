export const FOREGROUND_SEQUENCE_STEP_PREFIX = 'happier-turn-step-';
export function isForegroundSequenceStepId(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith(FOREGROUND_SEQUENCE_STEP_PREFIX);
}
