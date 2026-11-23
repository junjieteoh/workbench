import { describe, expect, it, vi } from 'vitest';
import { applyAgentReviewChoice, findAgentReviewToken, formatAgentReviewMentionToken, resolveAgentReviewSuggestions, type AgentReviewComposerBinding } from './agentReviewComposer';

const target = { agentId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, label: 'Claude Code' } as const;
const binding: AgentReviewComposerBinding = {
    matchesTargetPrefix: query => target.label.toLowerCase().startsWith(query.toLowerCase()),
    selection: null, onSelectionChange: vi.fn(),
    resolveTargets: vi.fn(async () => [target]),
    resolveModels: vi.fn(async () => [{ id: null, label: 'Provider default' }, { id: 'model-x', label: 'Model X' }]),
};

describe('agent review suggestions', () => {
    it('replaces an existing reviewer in the middle of an assignment without changing its instructions', () => {
        const text = 'Check @"Claude Code" against @agent:gemini/ tomorrow';
        const end = text.indexOf(' tomorrow');
        const result = applyAgentReviewChoice({ text, selection: { start: end, end }, token: '@Gemini', kinds: ['agentReview'], modelChosen: true, previous: target });
        expect(result.text).toBe('Check against @Gemini tomorrow');
        expect(result.text.slice(result.cursorPosition)).toBe('tomorrow');
        expect(findAgentReviewToken('Ask @"Claude Code": check this', target)).toBe(4);
        expect(findAgentReviewToken('Ask @"Claude Code", please', target)).toBe(4);
    });

    it('shows a discovery error and preserves explicit default selection semantics', async () => {
        const unavailable = { ...binding, resolveModels: async () => { throw new Error('offline'); } };
        const [row] = await resolveAgentReviewSuggestions({ binding: unavailable, query: 'agent:claude/', scopedQuery: 'claude/', scope: 'agent' });
        expect(row.agentReview).toEqual({ kind: 'status' });
        expect(row.key).toBe('agentReview:unavailable');
    });

    it('opens a target and chooses a model without querying models for other mentions', async () => {
        expect(await resolveAgentReviewSuggestions({ binding, query: 'README.md', scopedQuery: 'README.md', scope: null })).toEqual([]);
        const agents = await resolveAgentReviewSuggestions({ binding, query: 'agent', scopedQuery: '', scope: 'agent' });
        expect(agents[0].agentReview).toMatchObject({ kind: 'target', target });
        expect(binding.resolveModels).not.toHaveBeenCalled();
        const token = agents[0].text;
        const models = await resolveAgentReviewSuggestions({ binding, query: token.slice(1), scopedQuery: token.slice('@agent:'.length), scope: 'agent' });
        expect(models.map((option) => option.label)).toEqual(['Provider default', 'Model X']);
        expect(models[1].agentReview).toMatchObject({ kind: 'model', selection: { target, modelId: 'model-x', modelLabel: 'Model X' } });
        expect(models[1].text).toBe(formatAgentReviewMentionToken(target));
    });
});
