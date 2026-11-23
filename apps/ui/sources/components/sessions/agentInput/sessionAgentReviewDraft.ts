import { findAgentReviewToken, formatAgentReviewMentionToken, type ComposerAgentReviewTarget } from './agentReviewComposer';
import type {
    ComposerAgentReviewMention,
    ComposerStructuredInputMention,
} from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

export function readReviewMention(mentions: readonly ComposerStructuredInputMention[]): ComposerAgentReviewMention | null {
    return mentions.find((mention): mention is ComposerAgentReviewMention => (
        mention.kind === 'agentReview' && 'selection' in mention
    )) ?? null;
}

export function replaceReviewMention(
    mentions: readonly ComposerStructuredInputMention[],
    next: ComposerAgentReviewMention | null,
): ComposerStructuredInputMention[] {
    const others = mentions.filter((mention) => mention.kind !== 'agentReview');
    return next ? [...others, next] : others;
}

/** A stale binding must never send after the user edits the token into a different name. */
export function getReviewAssignment(text: string, target: ComposerAgentReviewTarget): string | null {
    const index = findAgentReviewToken(text, target);
    if (index < 0) return null;
    const before = text.slice(0, index).trimEnd();
    const after = text.slice(index + formatAgentReviewMentionToken(target).length).replace(/^[,:]?\s*/, '');
    return [before, after].filter(Boolean).join(' ').trim();
}
