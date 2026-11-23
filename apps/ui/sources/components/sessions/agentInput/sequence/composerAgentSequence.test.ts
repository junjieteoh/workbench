import { describe, expect, it } from 'vitest';
import type { ComposerAgentReviewTarget } from '../agentReviewComposer';
import {
    formatComposerSequenceAddress, listComposerSequenceChoices, parseComposerAgentSequence,
    replaceComposerSequenceAddress, resolveComposerSequenceAddress, type ComposerSequenceCatalogEntry,
} from './composerAgentSequence';

const target = (id: 'claude' | 'gemini', label: string): ComposerAgentReviewTarget => ({
    backendTarget: { kind: 'builtInAgent', agentId: id }, agentId: id, label,
});
const claude = target('claude', 'Claude Code');
const gemini = target('gemini', 'Gemini');
const defaultModel = { id: null, label: 'Worker default' };
const opus = { id: 'model-abc', label: 'Claude Opus 5.5' };
const catalog: ComposerSequenceCatalogEntry[] = [
    { target: claude, models: [defaultModel, opus] },
    { target: gemini, models: [defaultModel, { id: 'gemini-neon-4', label: 'Neon' }] },
];

describe('a two-stage composer handoff', () => {
    it.each([' then ', ', then ', ', THEN, ', ' → ', '->', ' => ', ' and then '])('splits addressed instructions on %s', separator => {
        const text = '   @Opus plan first' + separator + '@gemini take over';
        const parsed = parseComposerAgentSequence(text);
        expect(parsed?.stages.map(({ address, instructions }) => [address, instructions])).toEqual([
            ['Opus', 'plan first'], ['gemini', 'take over'],
        ]);
        for (const stage of parsed!.stages) expect(text.slice(stage.start, stage.end)).toBe('@' + stage.address);
    });

    it('retains a partially typed second assignment and follows the native quoted mention grammar', () => {
        const parsed = parseComposerAgentSequence('@"Claude Code": Plan the résumé\nCarefully, then @gemini');
        expect(parsed?.stages[0]).toMatchObject({ address: 'Claude Code', instructions: 'Plan the résumé\nCarefully' });
        expect(parsed?.stages[1]).toMatchObject({ address: 'gemini', instructions: '' });
    });

    it.each(['review @claude then @gemini', '@claude review the draft', '@claude review @gemini', '@claude review\nthis then clarify',
        '@claude quote `then @gemini` verbatim', '@claude a then @gemini b then @codex c'])('leaves ordinary input or unsupported nesting untouched: %s', text => {
        expect(parseComposerAgentSequence(text)).toBeNull();
    });

    it('resolves whole model-name and id components and exact agent names from the supplied catalog', () => {
        expect(resolveComposerSequenceAddress('OPUS', catalog)).toMatchObject({ kind: 'resolved', selection: { target: claude, modelId: opus.id } });
        expect(resolveComposerSequenceAddress('neon', catalog)).toMatchObject({ kind: 'resolved', selection: { target: gemini, modelId: 'gemini-neon-4' } });
        expect(resolveComposerSequenceAddress('Gemini', catalog)).toMatchObject({ kind: 'resolved', selection: { target: gemini, modelId: null, modelLabel: defaultModel.label } });
        expect(resolveComposerSequenceAddress('pus', catalog)).toEqual({ kind: 'unknown' });
        expect(resolveComposerSequenceAddress('gpt', [])).toEqual({ kind: 'unknown' });
    });

    it('requires an explicit choice for ambiguous model names and honors the exact model ID', () => {
        const expanded = [...catalog, { target: { ...claude, backendTarget: { kind: 'configuredAcpBackend' as const, backendId: 'experiment' }, label: 'Second worker' },
            models: [defaultModel, { id: 'other-opus', label: 'Opus' + ' 6' }] }];
        const result = resolveComposerSequenceAddress('opus', expanded);
        expect(result.kind).toBe('ambiguous');
        if (result.kind === 'ambiguous') expect(result.choices.map(choice => choice.modelId).sort()).toEqual(['model-abc', 'other-opus']);
        expect(resolveComposerSequenceAddress(opus.id, expanded)).toMatchObject({ kind: 'resolved', selection: { target: claude, modelId: opus.id } });
    });

    it('changes exactly one address and round-trips an ambiguous configured backend with a nontrivial model ID', () => {
        const extra = { target: { agentId: 'customAcp' as const, backendTarget: { kind: 'configuredAcpBackend' as const, backendId: 'remote/qa' }, label: 'Gemini' },
            models: [{ id: 'models/qa #2[beta]', label: 'QA model' }] };
        const all = [...catalog, extra];
        const text = '  @opus: Plan first, THEN @gemini: update\n  all files';
        const selection = listComposerSequenceChoices(all).find(choice => choice.modelId === extra.models[0].id)!;
        const result = replaceComposerSequenceAddress(text, parseComposerAgentSequence(text)!.stages[1], selection);
        expect(result).toBe(text.replace('@gemini:', formatComposerSequenceAddress(selection) + ':'));
        const parsed = parseComposerAgentSequence(result)!;
        expect(resolveComposerSequenceAddress(parsed.stages[1].address, all)).toEqual({ kind: 'resolved', selection });
        expect(parsed.stages[1].instructions).toBe('update\n  all files');
    });
});
