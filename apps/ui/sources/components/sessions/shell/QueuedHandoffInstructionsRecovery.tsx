import * as React from 'react';
import type { SessionAgentTransitionQueueResultV1 } from '@happier-dev/protocol';
import { Modal } from '@/modal';
import { readQueuedHandoffInstructions, updateQueuedHandoffInstructions, type HandoffInstructions } from '@/sync/domains/input/drafts/queuedHandoffInstructions';
import { selectCanonicalOutboundHandoffForLocalId } from '@/sync/domains/session/input/selectCanonicalOutboundHandoffForLocalId';
import { storage } from '@/sync/domains/state/storage';
import type { StorageState } from '@/sync/store/types';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { SessionWarningActionBanner } from './SessionWarningActionBanner';
import { ComposerAuxiliaryFrame } from './view/ComposerAuxiliaryFrame';

function QueuedHandoffInstructionsRow({ copy, queue, sessionId, recordKey, onRemove }: Readonly<{
    copy: HandoffInstructions;
    queue: SessionAgentTransitionQueueResultV1;
    sessionId: string;
    recordKey: string;
    onRemove: (localId: string) => void;
}>) {
    const admitted = storage(React.useCallback((state: StorageState) =>
        selectCanonicalOutboundHandoffForLocalId(state, sessionId, copy.localId) !== 'absent', [sessionId, copy.localId]));
    const matching = 'localId' in queue && queue.localId === copy.localId ? queue : null;
    const spent = admitted || matching?.status === 'completed';
    React.useEffect(() => {
        if (spent) void updateQueuedHandoffInstructions(recordKey, copy.localId, null).then(() => onRemove(copy.localId)).catch(() => {});
    }, [spent, recordKey, copy.localId, onRemove]);
    if (spent || matching?.status === 'queued' || matching?.status === 'dispatching') return null;
    return (
        <ComposerAuxiliaryFrame>
            <SessionWarningActionBanner
                tone="neutral"
                testID={`session-handoff-instructions-${copy.localId}`}
                title={t('session.agentContinuation.savedInstructions')}
                body={copy.text.length > 90 ? `${copy.text.slice(0, 90)}…` : copy.text}
                actionLabel={t('common.copy')}
                actionAccessibilityLabel={t('common.copy')}
                actionTestID={`session-handoff-copy-${copy.localId}`}
                onActionPress={async () => {
                    if (!await setClipboardStringSafe(copy.text)) Modal.alert(t('common.error'), t('errors.operationFailed'));
                }}
                secondaryActions={[{
                    key: 'dismiss', label: t('common.close'), accessibilityLabel: t('common.close'),
                    testID: `session-handoff-dismiss-${copy.localId}`, variant: 'quiet',
                    onPress: async () => {
                        try {
                            await updateQueuedHandoffInstructions(recordKey, copy.localId, null);
                            onRemove(copy.localId);
                        } catch { Modal.alert(t('common.error'), t('errors.operationFailed')); }
                    },
                }]}
            />
        </ComposerAuxiliaryFrame>
    );
}

export function QueuedHandoffInstructionsRecovery({ sessionId, recordKey, queue }: Readonly<{
    sessionId: string;
    recordKey: string;
    queue: SessionAgentTransitionQueueResultV1 | null;
}>) {
    const [copies, setCopies] = React.useState<HandoffInstructions[]>([]);
    React.useEffect(() => {
        let current = true;
        if (queue) void readQueuedHandoffInstructions(recordKey).then((result) => {
            if (current) setCopies(result);
        }).catch(() => {});
        return () => { current = false; };
    }, [recordKey, queue]);
    const remove = React.useCallback((localId: string) => setCopies((previous) => previous.filter((copy) => copy.localId !== localId)), []);
    if (!queue) return null;
    return <>{copies.map((copy) => <QueuedHandoffInstructionsRow key={copy.localId} copy={copy} queue={queue} sessionId={sessionId} recordKey={recordKey} onRemove={remove} />)}</>;
}
