import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAgentReviewChoice, applyComposerReplyChoice, findAgentReviewToken, formatAgentReviewMentionToken, resolveAgentReviewSuggestions, type AgentReviewComposerBinding } from './agentReviewComposer';

const target = { agentId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, label: 'Claude Code' } as const;
const binding: AgentReviewComposerBinding = {
    matchesTargetPrefix: query => target.label.toLowerCase().startsWith(query.toLowerCase()),
    selection: null, onSelectionChange: vi.fn(),
    resolveTargets: vi.fn(async () => [target]),
    resolveModels: vi.fn(async () => [{ id: null, label: 'Provider default' }, { id: 'model-x', label: 'Model X' }]),
};

describe('agent review suggestions', () => {
    beforeEach(() => { vi.clearAllMocks(); });
    it('replaces an existing reviewer in the middle of an assignment without changing its instructions', () => {
        const text = 'Check @"Claude Code" against @agent:gemini/ tomorrow';
        const end = text.indexOf(' tomorrow');
        const result = applyAgentReviewChoice({ text, selection: { start: end, end }, token: '@Gemini', kinds: ['agentReview'], modelChosen: true, previous: target });
        expect(result.text).toBe('Check against @Gemini tomorrow');
        expect(result.text.slice(result.cursorPosition)).toBe('tomorrow');
        expect(findAgentReviewToken('Ask @"Claude Code": check this', target)).toBe(4);
        expect(findAgentReviewToken('Ask @"Claude Code", please', target)).toBe(4);
    });

    it('preserves ordered assignments, existing instructions and unrelated file mentions on a foreground pick', () => {
        const selection = { target, modelId: 'work/agent', modelLabel: 'Model A' };
        const apply = (text: string, needle: string) => {
            const offset = text.lastIndexOf(needle);
            return applyComposerReplyChoice(text, {offset, endOffset: offset + needle.length}, selection).text;
        };
        expect(apply('@grok read @README.md', '@grok')).toBe('@reply:claude/work%2Fagent read @README.md');
        expect(apply('@reply:cursor/old Review @grok this', '@grok')).toBe('@reply:claude/work%2Fagent Review this');
        expect(apply('Draft first then pass to @grok review', '@grok')).toBe('Draft first then pass to @claude/work%2Fagent review');
        expect(apply('@gemini draft, then @grok edit', '@grok')).toBe('@gemini draft, then @claude/work%2Fagent edit');
    });

    it('finds actual foreground models by family name and qualified ID across the enabled machines targets', async () => {
        const cursor = { agentId: 'cursor', backendTarget: {kind: 'builtInAgent', agentId: 'cursor'}, label: 'Cursor'} as const;
        const custom = { agentId: 'customAcp', backendTarget: {kind: 'configuredAcpBackend', backendId: 'tool/b'}, label: 'Studio'} as const;
        const models = new Map<string, {id: string; label: string}[]>([
            ['cursor', [{id: 'vendor/grok-4.7', label: 'Grok 4.7'}]],
            ['customAcp', [{id: 'custom-grok-fast', label: 'Grok Fast'}]],
            ['claude', [{id: 'claude-haiku-latest', label: 'Haiku'}]],
        ]);
        const resolveModels = vi.fn(async (source: Parameters<AgentReviewComposerBinding['resolveModels']>[0]) => models.get(source.agentId) ?? []);
        const foreground = { ...binding, replyTargets: [target, cursor, custom], reviewEnabled: false, resolveModels };
        const search = (query: string) => resolveAgentReviewSuggestions({binding: foreground, query, scopedQuery: query, scope: null});
        expect((await search('')).map(item => item.key)).toContain('agentReview:cursor');
        expect(resolveModels).not.toHaveBeenCalled();
        const rows = await search('grok');
        expect(rows.map(row => row.agentReview)).toEqual([
            {kind: 'reply', selection: {target: cursor, modelId: 'vendor/grok-4.7', modelLabel: 'Grok 4.7'}},
            {kind: 'reply', selection: {target: custom, modelId: 'custom-grok-fast', modelLabel: 'Grok Fast'}},
        ]);
        expect((await search('hai'))[0]?.agentReview).toMatchObject({kind: 'reply', selection: {target, modelId: 'claude-haiku-latest'}});
        expect((await search('cursor/vendor%2Fgrok-4.7'))[0]?.agentReview).toMatchObject({kind: 'reply', selection: {target: cursor, modelId: 'vendor/grok-4.7'}});
        expect(await search('unlisted-model')).toEqual([]);
    });

    it('offers a foreground reply before the explicit delegation action for the same provider', async () => {
        const active = { ...binding, replyTargets: [target] };
        const scoped = (scopedQuery: string) => resolveAgentReviewSuggestions({binding: active, query:'agent:' + scopedQuery, scopedQuery, scope:'agent'});
        const actions = await scoped('claude/');
        expect(actions.map(item => item.agentReview?.kind)).toEqual(['open', 'delegate']);
        expect(actions[0].text).toBe('@agent:claude/reply/');
        const reply = await scoped('claude/reply/');
        expect(reply[0].agentReview).toMatchObject({kind:'reply', selection:{target, modelId:null}});
        expect(reply[1].agentReview).toMatchObject({kind:'reply', selection:{target, modelId:'model-x'}});
        expect((await scoped('claude/delegate/'))[1].agentReview?.kind).toBe('model');
    });

    it('shows a discovery error and preserves explicit default selection semantics', async () => {
        const unavailable = { ...binding, resolveModels: async () => { throw new Error('offline'); } };
        const [row] = await resolveAgentReviewSuggestions({ binding: unavailable, query: 'agent:claude/delegate/', scopedQuery: 'claude/delegate/', scope: 'agent' });
        expect(row.agentReview).toEqual({ kind: 'status' });
        expect(row.key).toBe('agentReview:unavailable');
    });

    it('opens a target and chooses a model without querying models for other mentions', async () => {
        expect(await resolveAgentReviewSuggestions({ binding, query: 'README.md', scopedQuery: 'README.md', scope: null })).toEqual([]);
        const agents = await resolveAgentReviewSuggestions({ binding, query: 'agent', scopedQuery: '', scope: 'agent' });
        expect(agents[0].agentReview).toMatchObject({ kind: 'target', target });
        expect(binding.resolveModels).not.toHaveBeenCalled();
        const token = agents[0].text;
        const actions = await resolveAgentReviewSuggestions({ binding, query: token.slice(1), scopedQuery: token.slice('@agent:'.length), scope: 'agent' });
        expect(actions.map(row => row.agentReview?.kind)).toEqual(['delegate']);
        expect(binding.resolveModels).not.toHaveBeenCalled();
        const delegate = actions[0].text;
        const models = await resolveAgentReviewSuggestions({ binding, query: delegate.slice(1), scopedQuery: delegate.slice('@agent:'.length), scope: 'agent' });
        expect(models.map((option) => option.label)).toEqual(['Provider default', 'Model X']);
        expect(models[1].agentReview).toMatchObject({ kind: 'model', selection: { target, modelId: 'model-x', modelLabel: 'Model X' } });
        expect(models[1].text).toBe(formatAgentReviewMentionToken(target));
    });
});
