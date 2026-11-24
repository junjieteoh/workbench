import { describe, expect, it } from 'vitest';
import type { ComposerAgentReviewTarget } from '../agentReviewComposer';
import {
    formatComposerSequenceAddress, listComposerSequenceChoices, parseComposerAgentSequence,
    replaceComposerSequenceAddress, replaceComposerSequenceInstructions, reorderComposerSequence, resolveComposerSequenceAddress, type ComposerSequenceCatalogEntry,
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

    it.each(['and pass to', 'then pass to', 'and then pass it to', 'hand off to', 'and hand over to'])(
        'uses the selected agent for an unaddressed first task and a visible default after %s', divider => {
            const text = 'Generate a math problem ' + divider + ' @codex';
            const stages = parseComposerAgentSequence(text)?.stages;
            expect(stages?.map(stage => stage.instructions)).toEqual(['Generate a math problem', 'Take over from the previous turn.']);
            expect(stages?.[0]).toMatchObject({ implied: true });
            expect(stages?.[1].address).toBe('codex');
        });

    it('reads a selected one-turn reply without turning ordinary front-of-message mentions into routing', () => {
        expect(parseComposerAgentSequence('@reply:cursor/grok-4.7 Write a math problem')?.stages).toMatchObject([
            { address: 'cursor/grok-4.7', instructions: 'Write a math problem' },
        ]);
        expect(parseComposerAgentSequence('@README.md summarize this')).toBeNull();
        expect(parseComposerAgentSequence('@grok Write a math problem')).toBeNull();
    });

    it('keeps an explicitly selected first model when a second turn is added conversationally', () => {
        expect(parseComposerAgentSequence('@reply:cursor/grok-4.7 Write a question, then pass to @codex to solve it')?.stages)
            .toMatchObject([
                { address: 'cursor/grok-4.7', instructions: 'Write a question' },
                { address: 'codex', instructions: 'solve it' },
            ]);
    });

    it('preserves an explicit model and strips the connective from the successor assignment', () => {
        const text = '@codex/example-model Do X, then pass to @claude to review, then back to @codex to revise';
        const parsed = parseComposerAgentSequence(text)!;
        expect(parsed.stages.map(stage => [stage.address, stage.instructions])).toEqual([
            ['codex/example-model', 'Do X'], ['claude', 'review'], ['codex', 'revise'],
        ]);
        expect(replaceComposerSequenceInstructions(text, parsed.stages[1], 'check details')).toBe(text.replace('review', 'check details'));
    });

    it('lets the editor replace the implicit agent, change the default task and preserve both when moving a row', () => {
        const text = 'Draft the summary and pass to @gemini';
        const parsed = parseComposerAgentSequence(text)!;
        const first = listComposerSequenceChoices(catalog).find(choice => choice.modelId === opus.id)!;
        expect(replaceComposerSequenceAddress(text, parsed.stages[0], first)).toBe('@claude/model-abc ' + text);
        const edited = replaceComposerSequenceInstructions(text, parsed.stages[0], 'Gather facts');
        expect(parseComposerAgentSequence(edited)?.stages[0].instructions).toBe('Gather facts');
        expect(replaceComposerSequenceInstructions(text, parsed.stages[1], 'Review the figures')).toBe(text + ' Review the figures');
        const moved = reorderComposerSequence(text, parsed, { kind: 'up', index: 1 }, formatComposerSequenceAddress(first));
        expect(parseComposerAgentSequence(moved)?.stages.map(stage => [stage.address, stage.instructions])).toEqual([
            ['gemini', 'Take over from the previous turn.'], ['claude/model-abc', 'Draft the summary'],
        ]);
        const cleared = replaceComposerSequenceInstructions(text, parsed.stages[1], '');
        expect(parseComposerAgentSequence(cleared)?.stages[1].instructions).toBe('');
    });

    it.each(['Review "pass to @codex" literally', 'Show `pass to @codex` as code', 'Draft a note to @codex',
        'Write an email and then @codex', 'What does "and pass to @codex" mean?'])('leaves unaddressed prose alone: %s', text => {
        expect(parseComposerAgentSequence(text)).toBeNull();
    });

    it('retains a partially typed second assignment and follows the native quoted mention grammar', () => {
        const parsed = parseComposerAgentSequence('@"Claude Code": Plan the résumé\nCarefully, then @gemini');
        expect(parsed?.stages[0]).toMatchObject({ address: 'Claude Code', instructions: 'Plan the résumé\nCarefully' });
        expect(parsed?.stages[1]).toMatchObject({ address: 'gemini', instructions: '' });
    });

    it.each(['review @claude then @gemini', '@claude review the draft', '@claude review @gemini', '@claude review\nthis then clarify',
        '@claude quote `then @gemini` verbatim'])('leaves ordinary input or unsupported nesting untouched: %s', text => {
        expect(parseComposerAgentSequence(text)).toBeNull();
    });

    it('parses repeated agents, a return handoff and incomplete addressed turns in order', () => {
        const text = '@claude draft this, then @gemini review it, then back to @claude to revise';
        const result = parseComposerAgentSequence(text)!;
        expect(result.stages.map(stage => [stage.address, stage.instructions])).toEqual([
            ['claude', 'draft this'], ['gemini', 'review it'], ['claude', 'revise'],
        ]);
        for (const tail of [', then @', ', then', ' → ']) {
            const incomplete = parseComposerAgentSequence(text + tail)!.stages[3];
            expect(incomplete).toMatchObject({ address: '', instructions: '' });
            const choice = listComposerSequenceChoices(catalog)[0];
            const fixed = replaceComposerSequenceAddress(text + tail, incomplete, choice);
            expect(parseComposerAgentSequence(fixed)?.stages[3].address).toBe('claude');
        }
        const changed = replaceComposerSequenceInstructions(text, result.stages[1], 'Quote "then @gemini" literally, then @data for the example. ');
        expect(parseComposerAgentSequence(changed)?.stages.map(stage => stage.instructions)).toEqual([
            'draft this', 'Quote "then @gemini" literally, then @data for the example. ', 'revise',
        ]);
    });

    it('adds an incomplete turn and moves or removes entire assignments without losing their model and instructions', () => {
        const text = '@opus draft, then @gemini review, then back to @claude to revise';
        const move = reorderComposerSequence(text, parseComposerAgentSequence(text)!, { kind: 'up', index: 2 });
        expect(move).toBe('@opus draft, then @claude revise, then @gemini review');
        const remove = reorderComposerSequence(move, parseComposerAgentSequence(move)!, { kind: 'remove', index: 0 });
        expect(remove).toBe('@claude revise, then @gemini review');
        expect(reorderComposerSequence(remove, parseComposerAgentSequence(remove)!, { kind: 'add' })).toBe(remove + ', then @');
        expect(reorderComposerSequence(remove, parseComposerAgentSequence(remove)!, { kind: 'remove', index: 0 })).toBe(remove);
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
