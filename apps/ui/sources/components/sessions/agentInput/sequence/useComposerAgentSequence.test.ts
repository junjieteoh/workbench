import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import type { AgentReviewComposerBinding, ComposerAgentReviewModel, ComposerAgentReviewTarget } from '../agentReviewComposer';
import { useComposerAgentSequence } from './useComposerAgentSequence';

const claude: ComposerAgentReviewTarget = { agentId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, label: 'Claude' };
const gemini: ComposerAgentReviewTarget = { agentId: 'gemini', backendTarget: { kind: 'builtInAgent', agentId: 'gemini' }, label: 'Gemini' };
const codex: ComposerAgentReviewTarget = { agentId: 'codex', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, label: 'Codex' };
const normal: ComposerAgentReviewModel = { id: null, label: 'Default' };
const opus = { id: 'claude-opus-a', label: 'Opus A' };
const alternative = { id: 'claude-opus-b', label: 'Opus B' };
function binding(resolveModels: AgentReviewComposerBinding['resolveModels']) {
    return { resolveTargets: vi.fn(async () => [claude, gemini]), resolveModels, matchesTargetPrefix: () => false, onSelectionChange: vi.fn(), selection: null };
}

describe('composer sequence discovery', () => {
    it('discovers only on a sequence, uses plan-capable agents, and keeps independent role and catalog choices across edits', async () => {
        const actors = binding(vi.fn(async (target: ComposerAgentReviewTarget) => target === claude ? [normal, opus, alternative] : [normal]));
        const hook = await renderHook(({ text }: { text: string }) => useComposerAgentSequence({
            text, binding: actors, successorTargets: [gemini, codex], currentTargetKey: buildBackendTargetKey(claude.backendTarget), currentModelId: opus.id,
        }), { initialProps: { text: '@opus review this' } });
        expect(hook.getCurrent().status).toBe('idle');
        expect(actors.resolveTargets).not.toHaveBeenCalled();
        const parsed = await hook.rerender({ text: '@opus plan first, then @gemini take over' });
        expect(actors.resolveTargets).toHaveBeenCalledWith(expect.any(AbortSignal), 'plan');
        expect(parsed.ready).toMatchObject({ planner: { target: claude, modelId: opus.id }, successor: { target: gemini, modelId: null } });
        expect(parsed.steps?.map(step => step.task)).toEqual(['plan first', 'take over']);
        expect(parsed.optionsByStep[0].some(option => option.key === '@codex')).toBe(false);
        expect(parsed.optionsByStep[1].some(option => option.key === '@codex')).toBe(true);
        expect(parsed.replace(1, '@codex')).toBe('@opus plan first, then @codex take over');
        await hook.rerender({ text: '@opus plan the details, then @gemini take over' });
        expect(actors.resolveTargets).toHaveBeenCalledTimes(1);
        expect(actors.resolveModels).toHaveBeenCalledTimes(3);
        expect((await hook.rerender({ text: '@opus plan the details, then @gemini' })).ready).toBeNull();
    });

    it('leaves ambiguous and unknown agents unresolved and can replace one in place from the available choices', async () => {
        const actors = binding(async (target) => target === claude ? [normal, opus, alternative] : [normal]);
        const hook = await renderHook(({text}: {text: string}) => useComposerAgentSequence({ text, binding: actors }),
            { initialProps: { text: '@opus check, then @gemini apply' } });
        expect(hook.getCurrent().status).toBe('ambiguous');
        expect(hook.getCurrent().ready).toBeNull();
        const corrected = hook.getCurrent().replace(0, '@claude/claude-opus-b');
        expect((await hook.rerender({ text: corrected! })).ready?.planner.modelId).toBe(alternative.id);
        expect((await hook.rerender({ text: '@invented check, then @gemini apply' })).status).toBe('unknown');
    });

    it('does not block exact provider choices or qualified models on another provider lookup, or reuse a prior session result', async () => {
        let finishOld!: (models: readonly ComposerAgentReviewModel[]) => void;
        const pending = new Promise<readonly ComposerAgentReviewModel[]>(resolve => { finishOld = resolve; });
        const old = binding(async (target) => target === gemini ? pending : [normal, opus]);
        const newBinding = binding(async () => { throw new Error('machine offline'); });
        const hook = await renderHook(({session}: {session: string}) => useComposerAgentSequence({
            text: '@claude/claude-opus-a plan then @gemini execute', scopeKey: session, binding: session === 'a' ? old : newBinding,
        }), { initialProps: { session: 'a' } });
        expect(hook.getCurrent().status).toBe('ready');
        expect((await hook.rerender({ session: 'b' })).status).toBe('unavailable');
        await act(async () => { finishOld([normal, opus]); });
        expect(hook.getCurrent().ready).toBeNull();
    });
});
