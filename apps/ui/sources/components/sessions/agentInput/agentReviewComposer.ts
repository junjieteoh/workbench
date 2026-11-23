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
    onSelectionChange(value: ComposerAgentReviewSelection | null): void;
    matchesTargetPrefix(query: string): boolean;
    resolveTargets(signal?: AbortSignal): Promise<readonly ComposerAgentReviewTarget[]>;
    resolveModels(target: ComposerAgentReviewTarget, signal?: AbortSignal): Promise<readonly ComposerAgentReviewModel[]>;
}>;
export type AgentReviewSuggestionAction =
    | { kind: 'open' | 'status' }
    | { kind: 'target'; target: ComposerAgentReviewTarget }
    | { kind: 'model'; selection: ComposerAgentReviewSelection };

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
    const bareTarget = scope === null && !!query && binding.matchesTargetPrefix(query);
    if (scope !== 'agent' && !bareTarget) {
        return scope === null && !!query && 'agent'.startsWith(query.toLowerCase())
            ? [row('open', '@agent:', t('agentInput.agentReview.choose'), { kind: 'open' })] : [];
    }
    const separator = scopedQuery.indexOf('/');
    try {
        const targets = await binding.resolveTargets(signal);
        if (signal?.aborted) return [];
        if (separator === -1) {
            const search = scopedQuery.toLowerCase();
            const matches = targets.filter(target => [target.label, targetQueryId(target)].some(value => {
                const name = value.toLowerCase();
                return bareTarget ? name.startsWith(search) : name.includes(search);
            }));
            if (matches.length) return matches.map(target => row(targetQueryId(target), '@agent:' + targetQueryId(target) + '/', target.label, { kind: 'target', target }));
        } else {
            const target = targets.find(item => targetQueryId(item) === scopedQuery.slice(0, separator));
            if (target) {
                const models = await binding.resolveModels(target, signal);
                const search = scopedQuery.slice(separator + 1).toLowerCase();
                const matches = models.filter(model => [model.label, model.id].some(value => value?.toLowerCase().includes(search)));
                if (matches.length) return matches.map(model => ({
                    ...row(targetQueryId(target) + '/' + (model.id ?? ''), formatAgentReviewMentionToken(target), model.label,
                        { kind: 'model', selection: { target, modelId: model.id, modelLabel: model.label } }),
                    ...(model.source ? { description: t(model.source === 'cached' ? 'agentInput.agentReview.cachedModels' : 'agentInput.agentReview.catalogModels') } : {}),
                }));
            }
        }
        if (bareTarget) return [];
        return [row('none', '@' + query, t('agentInput.agentReview.none'), { kind: 'status' })];
    } catch {
        return signal?.aborted ? [] : [row('unavailable', '@' + query, t('agentInput.agentReview.unavailable'), { kind: 'status' })];
    }
}
