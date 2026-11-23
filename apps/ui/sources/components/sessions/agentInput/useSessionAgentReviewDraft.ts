import * as React from 'react';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import { useExistingSessionDraftSemanticValue } from '@/hooks/session/useExistingSessionDraftSemanticValue';
import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { existingSessionDraftSemanticValues as drafts } from '@/sync/domains/input/drafts/existingSessionDraftSemanticValues';
import type { ComposerAgentReviewMention, ComposerAgentReviewSelection } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import { captureSessionAgentReviewContext, startSessionAgentReview } from '@/sync/ops/startSessionAgentReview';

import { formatAgentReviewMentionToken } from './agentReviewComposer';
import { readReviewMention, replaceReviewMention } from './sessionAgentReviewDraft';

const field = 'structuredInput.mentions';

export function useSessionAgentReviewDraft(scope: ServerAccountScope | null, sessionId: string) {
    const mentions = useExistingSessionDraftSemanticValue(scope, sessionId, field);
    const mention = readReviewMention(mentions ?? []);
    const frozenContext = React.useRef<{ id: string; text: string } | null>(null);

    const select = React.useCallback((selection: ComposerAgentReviewSelection | null) => {
        if (!scope) return;
        const current = drafts.read(scope, sessionId, field) ?? [];
        drafts.write(scope, sessionId, field, replaceReviewMention(current, selection ? {
            kind: 'agentReview', localId: randomUUID(), selection, tokenText: formatAgentReviewMentionToken(selection.target),
        } : null));
    }, [scope, sessionId]);

    function start(address: ComposerAgentReviewMention, instructions: string, serverId: string | null | undefined) {
        // An uncertain network reply keeps the same request identity, even if the composer reopens.
        // Changing the assignment is a new request. Changing the model creates a new mention.
        const id = address.localId + ':' + bytesToHex(sha256(utf8ToBytes(instructions)));
        if (frozenContext.current?.id !== id || !frozenContext.current.text) {
            frozenContext.current = { id, text: captureSessionAgentReviewContext(sessionId) };
        }
        return startSessionAgentReview({
            sessionId, serverId, backendTarget: address.selection.target.backendTarget,
            modelId: address.selection.modelId, instructions, startRequestId: id, transcriptContext: frozenContext.current.text,
        });
    }

    function isCurrent(address: ComposerAgentReviewMention) {
        return scope !== null && readReviewMention(drafts.read(scope, sessionId, field) ?? [])?.localId === address.localId;
    }

    return { mention, select, start, isCurrent };
}
