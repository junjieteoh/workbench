import { formatComposerSuggestionToken, parseComposerSuggestionQuery, parseComposerTokenEnd } from '@/components/autocomplete/composerSuggestionGrammar';
import { t } from '@/text';

import type { ComposerAgentReviewModel, ComposerAgentReviewSelection, ComposerAgentReviewTarget } from '../agentReviewComposer';

export type ComposerSequenceStage = Readonly<{
    /** Address without the @ or enclosing quotes. start/end cover the original @token only. */
    address: string;
    start: number;
    end: number;
    instructions: string;
    instructionStart: number;
    instructionEnd: number;
}>;
export type ComposerAgentSequence = Readonly<{ stages: readonly ComposerSequenceStage[] }>;
export type ComposerSequenceCatalogEntry = Readonly<{ target: ComposerAgentReviewTarget; models: readonly ComposerAgentReviewModel[] }>;
export type ComposerSequenceAddressResolution =
    | { kind: 'resolved'; selection: ComposerAgentReviewSelection }
    | { kind: 'ambiguous'; choices: readonly ComposerAgentReviewSelection[] }
    | { kind: 'unknown' };

/** Ignore instructions quoting a handoff, including Markdown code and JSON strings. */
const markerPattern = /(?<ticks>\x60+)|"(?:\\[\s\S]|""|[^"\\])*"|(?<divider>\b(?:and\s+)?then\b,?(?:\s+(?<back>back\s+to)\b)?(?=\s|$)|→|->|=>)\s*(?=@|$)/giu;

function readStage(text: string, start: number, limit: number, returning: boolean): ComposerSequenceStage {
    if (start === limit) return { address: '', start, end: start, instructions: '', instructionStart: start, instructionEnd: start };
    let end = parseComposerTokenEnd(text, start, limit);
    if (text.charAt(end - 1) === ':') end -= 1;
    const token = text.slice(start, end);
    const rest = text.slice(end, limit);
    const valid = (!token.startsWith('@"') || /^@"(?:[^"\r\n]|"")+"$/u.test(token)) && (!rest || /^[\s,:]/u.test(rest));
    const address = valid ? parseComposerSuggestionQuery(token)?.query ?? '' : '';
    const leading = rest.match(/^\s*(?:[,:]\s*)?/u)?.[0].length ?? 0;
    let instructionStart = end + leading;
    if (returning) instructionStart += text.slice(instructionStart, limit).match(/^to\s+/iu)?.[0].length ?? 0;
    const raw = text.slice(instructionStart, limit).trimEnd();
    let instructions = raw;
    // Structured row edits can contain literal handoff syntax. Quote the whole
    // assignment in that case, while keeping ordinary prose intact.
    if (raw.startsWith('="') && raw.endsWith('"')) {
        try { instructions = JSON.parse(raw.slice(1)); } catch { /* In-progress text stays editable. */ }
    }
    return { address, start, end, instructions, instructionStart, instructionEnd: instructionStart + raw.length };
}

export function parseComposerAgentSequence(text: string): ComposerAgentSequence | null {
    let start = text.search(/\S/u);
    if (start < 0 || text[start] !== '@') return null;
    let codeTicks = '';
    let returning = false;
    const stages: ComposerSequenceStage[] = [];
    for (const match of text.matchAll(markerPattern)) {
        const { ticks, divider, back } = match.groups!;
        if (ticks) {
            if (ticks === codeTicks) codeTicks = '';
            else if (!codeTicks) codeTicks = ticks;
            continue;
        }
        if (codeTicks || !divider || (/^\w/u.test(divider) && !/[\s,]/u.test(text.charAt(match.index - 1)))) continue;
        let limit = match.index;
        while (limit > start && /\s/u.test(text[limit - 1])) limit--;
        const comma = text[limit - 1] === ',';
        if (!stages.length && /^\w/u.test(divider) && !comma && match.index + match[0].length === text.length) continue;
        if (comma) limit--;
        stages.push(readStage(text, start, limit, returning));
        start = match.index + match[0].length;
        returning = Boolean(back);
    }
    if (!stages.length) return null;
    stages.push(readStage(text, start, text.length, returning));
    return { stages };
}

export function stageComposerHandoff(
    text: string, mention: { offset: number; endOffset: number },
    first: ComposerAgentReviewSelection, next: ComposerAgentReviewTarget,
): string {
    const before = text.slice(0, mention.offset);
    const firstTask = before.replace(/(?:[,;]?\s+(?:(?:and|then)\s+)?|^)(?:hand\s+(?:off|over)|pass)(?:\s+it)?\s+to\s*$/iu, '').trim();
    const nextTask = text.slice(mention.endOffset).trim() || t('agentInput.sequence.takeOverTask');
    const skeleton = formatComposerSequenceAddress(first) + ' → ' + formatComposerSequenceAddress({ target: next, modelId: null, modelLabel: '' });
    const { stages } = parseComposerAgentSequence(skeleton)!;
    // Write each assignment through the existing grammar, preserving literal arrows and mentions inside it.
    return replaceComposerSequenceInstructions(
        replaceComposerSequenceInstructions(skeleton, stages[1], nextTask), stages[0], firstTask,
    );
}

export function replaceComposerSequenceInstructions(text: string, stage: ComposerSequenceStage, instructions: string): string {
    const missingAddress = stage.start === stage.end;
    const prefix = missingAddress
        ? (/\s/u.test(text.charAt(stage.start - 1)) ? '@ ' : ' @ ')
        : stage.instructionStart === stage.end && instructions ? ' ' : '';
    const replace = (input: string) => text.slice(0, stage.instructionStart) + prefix + input + text.slice(stage.instructionEnd);
    const candidate = replace(instructions);
    const before = parseComposerAgentSequence(text)?.stages;
    const after = parseComposerAgentSequence(candidate)?.stages;
    if (before && after && before.length === after.length && before.every((original, index) =>
        original.address === after[index].address && after[index].instructions === (original.start === stage.start ? instructions : original.instructions))) {
        return candidate;
    }
    // A task may itself contain "then @…", an unmatched code fence or literal
    // leading whitespace. Keep it a single assignment despite that grammar.
    return replace('=' + JSON.stringify(instructions));
}

export type ComposerSequenceOrderChange = { kind: 'add' } | { kind: 'up' | 'down' | 'remove'; index: number };

export function reorderComposerSequence(
    text: string, sequence: ComposerAgentSequence, change: ComposerSequenceOrderChange, firstAddress?: string,
): string {
    const rows = sequence.stages.map((stage, index) => {
        const address = (index === 0 && firstAddress) || text.slice(stage.start, stage.end) || '@';
        const task = text.slice(stage.instructionStart, stage.instructionEnd);
        return task ? address + ' ' + task : address;
    });
    if (change.kind === 'add') rows.push('@');
    else {
        const { index } = change;
        if (!Number.isInteger(index) || index < 0 || index >= rows.length) return text;
        if (change.kind === 'remove') {
            if (rows.length <= 2) return text;
            rows.splice(index, 1);
        } else {
            const to = change.kind === 'up' ? index - 1 : index + 1;
            if (to < 0 || to >= rows.length) return text;
            [rows[index], rows[to]] = [rows[to], rows[index]];
        }
    }
    return rows.join(', then ');
}

export function composerSequenceTargetAddress(target: ComposerAgentReviewTarget): string {
    const backend = target.backendTarget;
    return backend.kind === 'builtInAgent' ? backend.agentId : 'acp:' + encodeURIComponent(backend.backendId);
}

export function formatComposerSequenceAddress(choice: ComposerAgentReviewSelection): string {
    const target = composerSequenceTargetAddress(choice.target);
    return formatComposerSuggestionToken('@', choice.modelId === null ? target : target + '/' + encodeURIComponent(choice.modelId));
}

export function replaceComposerSequenceAddress(text: string, stage: ComposerSequenceStage, choice: ComposerAgentReviewSelection): string {
    if (stage.address && parseComposerSuggestionQuery(text.slice(stage.start, stage.end))?.query !== stage.address) return text;
    const gap = stage.start === stage.end && !/\s/u.test(text.charAt(stage.start - 1)) ? ' ' : '';
    return text.slice(0, stage.start) + gap + formatComposerSequenceAddress(choice) + text.slice(stage.end);
}

export function listComposerSequenceChoices(catalog: readonly ComposerSequenceCatalogEntry[]): ComposerAgentReviewSelection[] {
    const choices = new Map<string, ComposerAgentReviewSelection>();
    for (const { target, models } of catalog) {
        const providerDefault = models.find(model => model.id === null) ?? { id: null, label: t('agentInput.model.useCliSettings') };
        for (const model of [providerDefault, ...models]) {
            const choice = { target, modelId: model.id, modelLabel: model.label };
            choices.set(formatComposerSequenceAddress(choice), choice);
        }
    }
    return [...choices.values()];
}

function resolution(choices: ComposerAgentReviewSelection[]): ComposerSequenceAddressResolution {
    if (!choices.length) return { kind: 'unknown' };
    if (choices.length === 1) return { kind: 'resolved', selection: choices[0] };
    return { kind: 'ambiguous', choices };
}

function words(name: string): string {
    return name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
}

function resolveModel(name: string, choices: ComposerAgentReviewSelection[]): ComposerSequenceAddressResolution {
    const parts = words(name);
    const lower = name.toLowerCase();
    const models = choices.filter(choice => choice.modelId !== null);
    const exact = models.filter(choice => choice.modelId === name);
    if (exact.length) return resolution(exact);
    const labels = models.filter(choice => choice.modelId?.toLowerCase() === lower || choice.modelLabel.toLowerCase() === lower);
    if (labels.length) return resolution(labels);
    if (!parts) return { kind: 'unknown' };
    const matches = models.filter(choice => [choice.modelId!, choice.modelLabel].some(value =>
        (' ' + words(value) + ' ').includes(' ' + parts + ' ')));
    return resolution(matches);
}

export function resolveComposerSequenceAddress(address: string, catalog: readonly ComposerSequenceCatalogEntry[]): ComposerSequenceAddressResolution {
    const name = address.trim();
    if (!name) return { kind: 'unknown' };
    const choices = listComposerSequenceChoices(catalog);
    const lower = name.toLowerCase();
    const defaults = choices.filter(choice => choice.modelId === null);
    // The canonical machine target is unambiguous even if a different configured
    // backend uses its name as a display label.
    const canonical = defaults.filter(choice => composerSequenceTargetAddress(choice.target) === name);
    if (canonical.length) return resolution(canonical);
    const named = defaults.filter(choice => composerSequenceTargetAddress(choice.target).toLowerCase() === lower || choice.target.label.toLowerCase() === lower);
    if (named.length) return resolution(named);

    const slash = name.indexOf('/');
    if (slash !== -1) {
        const explicitTarget = name.slice(0, slash);
        const canonicalTarget = choices.filter(choice => composerSequenceTargetAddress(choice.target) === explicitTarget);
        const scoped = canonicalTarget.length ? canonicalTarget : choices.filter(choice =>
            [composerSequenceTargetAddress(choice.target), choice.target.label].some(label => label.toLowerCase() === explicitTarget.toLowerCase()));
        if (scoped.length) {
            const model = name.slice(slash + 1);
            const canonicalModels = scoped.filter(choice => choice.modelId !== null && encodeURIComponent(choice.modelId) === model);
            return canonicalModels.length ? resolution(canonicalModels) : resolveModel(model, scoped);
        }
    }
    return resolveModel(name, choices);
}
