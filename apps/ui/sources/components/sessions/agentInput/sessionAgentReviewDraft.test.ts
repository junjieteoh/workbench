import { describe, expect, it } from 'vitest';

import { ComposerStructuredInputMentionsSchema } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

import { getReviewAssignment, readReviewMention, replaceReviewMention } from './sessionAgentReviewDraft';

const selection = {
    target: { backendTarget: { kind: 'builtInAgent' as const, agentId: 'gemini' }, agentId: 'gemini' as const, label: 'Gemini' },
    modelId: 'selected-model',
    modelLabel: 'Selected model',
};

describe('session agent review draft', () => {
    it('restores the exact reviewer, model and request identity next to unrelated mentions', () => {
        const other = { kind: 'session' as const, sessionId: 'other', tokenText: '@note' };
        const mentions = replaceReviewMention([other], { kind: 'agentReview', tokenText: '@Gemini', selection, localId: 'review-1' });
        const restored = ComposerStructuredInputMentionsSchema.parse(JSON.parse(JSON.stringify(mentions)));
        expect(readReviewMention(restored)).toEqual(mentions[1]);
        expect(replaceReviewMention(restored, null)).toEqual([other]);
    });

    it('removes only the addressed mention from the assignment and detects an edited token', () => {
        expect(getReviewAssignment('@Gemini Review this draft', selection.target)).toBe('Review this draft');
        expect(getReviewAssignment('Please @Gemini check the dates', selection.target)).toBe('Please check the dates');
        expect(getReviewAssignment('@Gemini, review @Gemini references', selection.target)).toBe('review @Gemini references');
        expect(getReviewAssignment('@GeminiExtra review', selection.target)).toBeNull();
        expect(getReviewAssignment('mail@Gemini review', selection.target)).toBeNull();
        expect(getReviewAssignment('@Gemini', selection.target)).toBe('');
    });
});
