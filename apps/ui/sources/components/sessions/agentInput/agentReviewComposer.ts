import type { ComposerAgentReviewSelection } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import { applySuggestion } from '@/components/autocomplete/applySuggestion';
import type { ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionGrammar';
import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import { formatComposerSuggestionToken, isComposerTokenBoundaryChar } from '@/components/autocomplete/composerSuggestionGrammar';
import { t } from '@/text';

export type { ComposerAgentReviewSelection } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
export type ComposerAgentReviewTarget = ComposerAgentReviewSelection['target'];
export type ComposerAgentReviewModel = Readonly<{ id: string | null; label: string; source?: 'cached' | 'catalog' }>;
export type AgentReviewComposerBinding = Readonly<{
    selection: ComposerAgentReviewSelection | null;
    reviewEnabled?: boolean;
    handoff?: Readonly<{
        first: ComposerAgentReviewSelection;
        targets: readonly ComposerAgentReviewTarget[];
        onStage(): void;
    }>;
    onSelectionChange(value: ComposerAgentReviewSelection | null): void;
    matchesTargetPrefix(query: string): boolean;
    peekTargets?(): readonly ComposerAgentReviewTarget[] | null;
    resolveTargets(signal?: AbortSignal, intent?: 'delegate' | 'plan'): Promise<readonly ComposerAgentReviewTarget[]>;
    resolveModels(target: ComposerAgentReviewTarget, signal?: AbortSignal): Promise<readonly ComposerAgentReviewModel[]>;
}>;
export type AgentReviewSuggestionAction =
    | { kind: 'open' | 'status' | 'delegate' }
    | { kind: 'target'; target: ComposerAgentReviewTarget }
    | { kind: 'model'; selection: ComposerAgentReviewSelection }
    | { kind: 'handoff'; target: ComposerAgentReviewTarget };

export function formatAgentReviewMentionToken(target: ComposerAgentReviewTarget): string {
    return formatComposerSuggestionToken('@', target.label);
}

export function findAgentReviewToken(text: string, target: ComposerAgentReviewTarget): number {
    const token = formatAgentReviewMentionToken(target);
    let index = text.indexOf(token);
    while (index !== -1) {
        if (isComposerTokenBoundaryChar(text.charAt(index - 1)) && (isComposerTokenBoundaryChar(text.charAt(index + token.length)) || text.charAt(index + token.length) === ':')) return index;
        index = text.indexOf(token, index + token.length);
    }
    return -1;
}

export function removeAgentReviewToken(text: string, target: ComposerAgentReviewTarget): { text: string; start: number; length: number } {
    const start = findAgentReviewToken(text, target);
    if (start === -1) return { text, start, length: 0 };
    const tokenEnd = start + formatAgentReviewMentionToken(target).length;
    const end = tokenEnd + (text[tokenEnd] === ' ' ? 1 : 0);
    return { text: text.slice(0, start) + text.slice(end), start, length: end - start };
}

/** Replacing a reviewer keeps the surrounding assignment and restores the caret after the mention. */
export function applyAgentReviewChoice(params: {
    text: string;
    selection: { start: number; end: number };
    token: string;
    kinds: readonly ComposerSuggestionKindId[];
    modelChosen: boolean;
    previous: ComposerAgentReviewTarget | null;
}) {
    let { text, selection } = params;
    if (params.modelChosen && params.previous) {
        const removal = removeAgentReviewToken(text, params.previous);
        text = removal.text;
        if (removal.start >= 0 && removal.start < selection.start) {
            selection = { start: selection.start - removal.length, end: selection.end - removal.length };
        }
    }
    const result = applySuggestion(text, selection, params.token, params.kinds, params.modelChosen);
    // applySuggestion reuses a space already following the edited token. Advance over it
    // so a selection in the middle of a sentence closes the picker just like one at the end.
    if (params.modelChosen && result.text[result.cursorPosition] === ' ') result.cursorPosition += 1;
    return result;
}

function targetQueryId(target: ComposerAgentReviewTarget): string {
    return target.backendTarget.kind === 'configuredAcpBackend'
        ? 'acp:' + encodeURIComponent(target.backendTarget.backendId)
        : target.backendTarget.agentId;
}

export async function resolveAgentReviewSuggestions(params: {
    binding?: AgentReviewComposerBinding; query: string; scopedQuery: string; scope: string | null; signal?: AbortSignal;
}): Promise<AutocompleteSuggestion[]> {
    const { binding, query, scopedQuery, scope, signal } = params;
    if (!binding || signal?.aborted) return [];
    const row = (key: string, text: string, label: string, agentReview: AgentReviewSuggestionAction): AutocompleteSuggestion => ({
        kind: 'agentReview', key: 'agentReview:' + key, text, label, agentReview, agentReviewQuery: query,
    });
    const bareTarget = scope === null && (!query || binding.matchesTargetPrefix(query));
    if (scope !== 'agent' && !bareTarget) {
        return scope === null && !!query && 'agent'.startsWith(query.toLowerCase())
            ? [row('open', '@agent:', t('agentInput.agentReview.choose'), { kind: 'open' })] : [];
    }
    const separator = scopedQuery.indexOf('/');
    try {
        // The unscoped picker also shows files and sessions. Its discovery deadline
        // can omit a slow agent section for the lifetime of this query. Offer the
        // scoped picker immediately on a cold machine; it can await the live catalog.
        const handoffTargets = binding.handoff?.targets ?? [];
        const peek = !query && scope === null ? binding.peekTargets : undefined;
        const reviewTargets = binding.reviewEnabled === false ? []
            : peek ? peek() : await binding.resolveTargets(signal).catch(error => {
                if (!handoffTargets.length) throw error;
                return [];
            });
        if (peek && !reviewTargets?.length && !handoffTargets.length) {
            return [row('open', '@agent:', t('agentInput.agentReview.choose'), { kind: 'open' })];
        }
        if (signal?.aborted) return [];
        const targets = new Map([...handoffTargets, ...(reviewTargets ?? [])].map(target => [targetQueryId(target), target]));
        if (separator === -1) {
            const search = scopedQuery.toLowerCase();
            const matches = [...targets].filter(([id, target]) => [target.label, id].some(value => {
                const name = value.toLowerCase();
                return bareTarget ? name.startsWith(search) : name.includes(search);
            }));
            if (matches.length) return matches.map(([id, target]) => row(id, '@agent:' + id + '/', target.label, { kind: 'target', target }));
        } else {
            const id = scopedQuery.slice(0, separator);
            const target = targets.get(id);
            if (target) {
                const actionQuery = scopedQuery.slice(separator + 1).toLowerCase();
                const canDelegate = reviewTargets?.some(candidate => targetQueryId(candidate) === id);
                if (actionQuery.startsWith('delegate/')) {
                    if (!canDelegate) return [];
                    const search = actionQuery.slice('delegate/'.length);
                    const models = await binding.resolveModels(target, signal);
                    if (signal?.aborted) return [];
                    const matches = models.filter(model => [model.label, model.id].some(value => value?.toLowerCase().includes(search)));
                    if (matches.length) return matches.map(model => ({
                        ...row(id + '/' + (model.id ?? ''), formatAgentReviewMentionToken(target), model.label,
                            { kind: 'model', selection: { target, modelId: model.id, modelLabel: model.label } }),
                        ...(model.source ? { description: t(model.source === 'cached' ? 'agentInput.agentReview.cachedModels' : 'agentInput.agentReview.catalogModels') } : {}),
                    }));
                } else {
                    const handoffLabel = t('agentInput.sequence.handOff');
                    const delegateLabel = t('executionRuns.newRun.intents.delegate');
                    const actions: AutocompleteSuggestion[] = [];
                    if (handoffTargets.some(candidate => targetQueryId(candidate) === id) && handoffLabel.toLowerCase().includes(actionQuery)) {
                        actions.push(row(id + '/handoff', '@' + query, handoffLabel, { kind: 'handoff', target }));
                    }
                    if (canDelegate && delegateLabel.toLowerCase().includes(actionQuery)) {
                        actions.push(row(id + '/delegate', '@agent:' + id + '/delegate/', delegateLabel, { kind: 'delegate' }));
                    }
                    if (actions.length) return actions;
                }
            }
        }
        if (bareTarget) return [];
        return [row('none', '@' + query, t('agentInput.agentReview.none'), { kind: 'status' })];
    } catch {
        return signal?.aborted ? [] : [row('unavailable', '@' + query, t('agentInput.agentReview.unavailable'), { kind: 'status' })];
    }
}
