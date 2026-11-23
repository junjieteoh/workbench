import { isRecoveredHistoryTranscriptObservationProvenance } from '@happier-dev/protocol';
import type { StorageState } from '@/sync/store/types';
import type { ArmedAgentContinuationInputCustody } from './continueSessionWithArmedAgent';

/**
 * Where one submitted localId has got to, canonically — the single reader for
 * both questions the transition asks about it: whether it was admitted at all,
 * and whether anything has carried it yet.
 *
 * They are answered together because they come from the same two store slices,
 * and because a queued-input signal that cannot see `delivered` outlives the
 * message it describes: the armed outcome stays on screen for the life of the
 * Session, so a Session that answers and later idles out would otherwise be
 * reported as one whose message never went.
 */
export function selectCanonicalOutboundHandoffForLocalId(
    state: StorageState,
    sessionId: string,
    localId: string | null,
): ArmedAgentContinuationInputCustody {
    if (!localId) return 'absent';

    const sessionMessages = state.sessionMessages[sessionId];
    const messagesById = sessionMessages?.messagesById ?? sessionMessages?.messagesMap;
    // The transcript is checked FIRST: a materialized row is the stronger fact,
    // and a pending row can briefly survive its own materialization.
    const isDelivered = messagesById !== undefined && Object.values(messagesById).some((message) => (
        message.kind === 'user-text'
        && message.localId === localId
        && !isRecoveredHistoryTranscriptObservationProvenance(message.transcriptObservationProvenance)
    ));
    if (isDelivered) return 'delivered';

    const pending = state.sessionPending[sessionId];
    // `discarded` still proves admission, but nothing is waiting on a runtime
    // for it, so it does not count as queued.
    const isQueued = (pending?.messages ?? []).some((message) => (
        message.source === 'server_pending' && message.localId === localId
    ));
    if (isQueued) return 'queued';
    return (pending?.discarded ?? []).some((message) => (
        message.source === 'server_pending' && message.localId === localId
    )) ? 'delivered' : 'absent';
}
