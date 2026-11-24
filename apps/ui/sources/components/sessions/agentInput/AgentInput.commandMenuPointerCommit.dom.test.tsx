/**
 * @vitest-environment jsdom
 *
 * The composer, end to end, driven by a real pointer press.
 *
 * A completely dead `@` shipped with 242 green tests because **every** suite in
 * this corridor mocked the layer directly beneath the one it claimed to verify:
 * the ten `AgentInput.*` suites mock `useActiveSuggestions`, the two that would
 * otherwise render a picker mock `@/components/ui/commandMenu` to `() => null`,
 * `CommandMenu.test.tsx` and its native twin mock `CommandMenuSurface` away, and
 * every `components/autocomplete/**` suite stops at `getSuggestions`. Nothing
 * crossed more than one seam, so "the dispatcher returned rows" and "the user can
 * pick one" were indistinguishable — and both P0s lived in exactly that gap.
 *
 * This suite closes it. It mounts the real `AgentInput` with the real
 * `CommandMenu`, the real `CommandMenuSurface`, the real `SelectionList` rows and
 * the real `getSuggestions` registry, and presses a row with real DOM mouse
 * events. It asserts the only outcome the user cares about — **the composer text
 * changed** — never that a handler was called.
 *
 * Three harness decisions are load-bearing:
 *
 * 1. `react-native` resolves to the **real** `react-native-web`, so props reach
 *    the DOM through its actual whitelist. A hand-rolled `View` stub that spreads
 *    every prop onto a `div` will happily certify a handler the browser can never
 *    call — that is how `CommandMenuSurface.webFocus.test.tsx` first shipped green
 *    over an inert fix (`onMouseDownCapture` is dropped by react-native-web;
 *    `onMouseDown` is not).
 * 2. The shared Vitest config has **no platform-extension resolution**, so
 *    `@/components/ui/forms/MultiTextInput` would resolve to the *native* module
 *    inside a web-platform test. `setTextAndSelection` — the final hop of the whole
 *    commit path — has a different implementation per platform, so the web module
 *    is aliased in explicitly. A press test running the native text input would
 *    leave the web commit unpinned. (`useTextInputCaretRect` keeps its default
 *    `.native` resolution here; it only chooses the popover *anchor*, which is not
 *    this suite's contract.)
 * 3. `pressRow` performs the two steps jsdom omits. react-native-web invokes
 *    `Pressable`'s `onPress` from the native **`click`** event, not from responder
 *    release ("Only when the browser produces a `click` event is `onPress`
 *    invoked", `usePressEvents/PressResponder.js`) — and a browser produces no
 *    click when the pressed element disappears mid-gesture. jsdom also does not
 *    implement the focus-on-mousedown default action. Both are modelled, so the
 *    reported bug ("clicking a suggestion does nothing; you have to press Tab") is
 *    reproduced as a mechanism instead of asserted as a prop: an uncancelled
 *    mousedown blurs the composer, `AgentInput` drops the query, the row unmounts,
 *    and no click is ever delivered.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getSuggestions } from '@/components/autocomplete/suggestions';
import type { FileItem } from '@/sync/domains/input/suggestionFile';

// Static, not lazy: Vitest hoists every `vi.mock` factory below above the imports,
// so the mocks still apply — while importing this graph inside the first test
// charged its ~30 s transform to that test's own timeout budget.
import { AgentInput } from './AgentInput';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => await vi.importActual('react-native-web'));

// The web platform's own text input — see the header. Not a behavioural stub:
// this is the module Metro resolves for `platform: 'web'`.
vi.mock('@/components/ui/forms/MultiTextInput', async () => (
    await vi.importActual('@/components/ui/forms/MultiTextInput.web')
));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

// OS boundary. Mocked at the platform package rather than at our own
// `theme/haptics` wrapper so the app's own call path stays real.
vi.mock('expo-haptics', () => ({
    impactAsync: async () => {},
    notificationAsync: async () => {},
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

/** True system boundaries: the daemon file search and command search. */
const searchFilesMock = vi.hoisted(() => vi.fn(
    async (_scope: unknown, _query: string, _options?: Readonly<{ limit?: number }>): Promise<FileItem[]> => [],
));
const searchCommandsMock = vi.hoisted(() => vi.fn(async () => [] as unknown[]));

vi.mock('@/sync/domains/input/suggestionFile', () => ({ searchFiles: searchFilesMock }));
vi.mock('@/sync/domains/input/suggestionCommands', () => ({ searchCommands: searchCommandsMock }));

const SESSION_ID = 'session-a';
const WORKSPACE = { machineId: 'machine-a', path: '/repo', serverId: 'server-a' } as const;
const PROMPT_ARTIFACT_ID = 'artifact-prompt-1';
const PROMPT_TEMPLATE_TEXT = 'Write a really detailed plan before touching any code.';

const storageStateMock = vi.hoisted(() => ({
    sessions: {} as Record<string, unknown>,
    artifacts: {} as Record<string, { body?: string }>,
    machines: {} as Record<string, unknown>,
    updateArtifact: vi.fn(),
    applySessions: vi.fn(),
    getProjectForSession: vi.fn(),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const [{ createPartialStorageModuleMock }, { settingsDefaults }] = await Promise.all([
        import('@/dev/testkit/mocks/storage'),
        import('@/sync/domains/settings/settings'),
    ]);
    return createPartialStorageModuleMock(importOriginal as <T>() => Promise<T>, {
        storage: { getState: () => storageStateMock },
        useSettings: () => settingsDefaults,
        useSetting: (key: string) => (settingsDefaults as Record<string, unknown>)[key] ?? null,
        useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
        useSessionMessagesById: () => ({}),
        useSessionMessagesVersion: () => 0,
        useSessionMessagesReducerState: () => null,
        useSessionProjectScmSnapshot: () => null,
    });
});

/** `SessionView.tsx`'s eligible-kind subset for the session composer, verbatim. */
type ReviewBinding = import('./agentReviewComposer').AgentReviewComposerBinding;
type ReviewSelection = import('./agentReviewComposer').ComposerAgentReviewSelection;
type SubmitOptions = import('./agentInputSendOptions').AgentInputSendOptions;
const SESSION_COMPOSER_SUGGESTION_KINDS = ['file', 'vendorPlugin', 'skill', 'slashCommand', 'agentReview'] as const;

function file(fullPath: string): FileItem {
    const fileName = fullPath.split('/').pop() ?? fullPath;
    return {
        fileName,
        filePath: fullPath.slice(0, fullPath.length - fileName.length),
        fullPath,
        fileType: 'file',
    } as FileItem;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    searchFilesMock.mockReset();
    searchFilesMock.mockResolvedValue([]);
    searchCommandsMock.mockReset();
    searchCommandsMock.mockResolvedValue([]);
    storageStateMock.updateArtifact.mockReset();
    storageStateMock.machines = {};
    storageStateMock.artifacts = {
        [PROMPT_ARTIFACT_ID]: {
            body: JSON.stringify({
                v: 1,
                markdown: PROMPT_TEMPLATE_TEXT,
                createdAtMs: 0,
                updatedAtMs: 0,
            }),
        },
    };
    // Both catalog snapshots are present, so the catalog-backed kinds resolve from
    // session metadata and never reach the daemon RPC.
    storageStateMock.sessions = {
        [SESSION_ID]: {
            id: SESSION_ID,
            active: true,
            metadata: {
                path: '/repo',
                sessionVendorPluginCatalogV1: { vendorPlugins: [] },
                sessionSkillCatalogV1: { skills: [] },
            },
        },
    };
});

afterEach(async () => {
    await act(async () => {
        root.unmount();
    });
    container.remove();
});

type MountedComposer = Readonly<{
    /** The uncontrolled `<textarea>` the user sees and sends. */
    text: () => string;
    textarea: HTMLTextAreaElement;
}>;

/** Mounts the session composer wired exactly as `SessionView` wires it. */
async function renderSessionComposer(review?: Omit<ReviewBinding, 'selection' | 'onSelectionChange'>, onSend: (options?: SubmitOptions) => void = () => {}, agentSequence?: React.ComponentProps<typeof AgentInput>['agentSequence']): Promise<MountedComposer> {
    function Host() {
        const [value, setValue] = React.useState('');
        const [selection, onSelectionChange] = React.useState<ReviewSelection | null>(null);
        const agentReview = React.useMemo(() => review ? { ...review, selection, onSelectionChange } : undefined, [selection]);
        // `SessionView.handleAutocompleteSuggestions`, verbatim.
        const handler = React.useCallback(
            (query: string, signal: AbortSignal) => getSuggestions(SESSION_ID, query, {
                kinds: SESSION_COMPOSER_SUGGESTION_KINDS,
                workspace: WORKSPACE,
                agentReview,
                signal,
            }),
            [agentReview],
        );
        return (
            <AgentInput
                value={value}
                onChangeText={setValue}
                placeholder="Message"
                onSend={onSend}
                agentReview={agentReview}
                agentSequence={agentSequence}
                autocompleteKinds={SESSION_COMPOSER_SUGGESTION_KINDS}
                autocompleteSuggestions={handler}
                sessionId={SESSION_ID}
                metadata={null}
                disabled={false}
                showAbortButton={false}
            />
        );
    }

    await act(async () => {
        root.render(<Host />);
    });

    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('composer textarea did not mount');
    return { text: () => textarea.value, textarea };
}

/** Types into the composer the way a keystroke reaches React on web. */
async function typeIntoComposer(composer: MountedComposer, text: string) {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    await act(async () => {
        composer.textarea.focus();
        valueSetter?.call(composer.textarea, text);
        composer.textarea.setSelectionRange(text.length, text.length);
        composer.textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {});
}

function findMenuRow(optionId: string): HTMLElement | null {
    // The popover portals out of the render container, so search the document.
    // Encoded model IDs may contain percent escapes; compare the literal native test ID.
    const id = 'agent-input-command-menu:list:command-menu-root:option:' + optionId;
    return [...document.querySelectorAll<HTMLElement>('[data-testid*="command-menu-root:option:"]')]
        .find(node => node.getAttribute('data-testid') === id) ?? null;
}

type PressOutcome = Readonly<{
    /** The surface cancelled the pointer-down default, so focus stayed put. */
    pointerDownCancelled: boolean;
    /** The row was still mounted when the gesture ended, so a click was delivered. */
    clickDelivered: boolean;
}>;

/**
 * A real pointer press, including the two steps jsdom leaves out (see the header).
 */
async function pressRow(composer: MountedComposer, optionId: string): Promise<PressOutcome> {
    const row = findMenuRow(optionId);
    if (!row) throw new Error(`suggestion row "${optionId}" is not rendered`);

    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
        row.dispatchEvent(down);
        if (!down.defaultPrevented) {
            // The browser's default action for a pointer press: focus moves to what
            // was pressed, which blurs the composer.
            composer.textarea.blur();
        }
    });

    const survivor = findMenuRow(optionId);
    if (survivor) {
        await act(async () => {
            survivor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
            survivor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        });
    }
    await act(async () => {});

    return { pointerDownCancelled: down.defaultPrevented, clickDelivered: survivor !== null };
}

describe('AgentInput — a pointer press on a suggestion rewrites the composer', () => {
    it('selects a real foreground model as the next speaker while a different provider is still discovering', async () => {
        const cursor = { agentId: 'cursor', label: 'Cursor', backendTarget: { kind: 'builtInAgent', agentId: 'cursor' } } as const;
        const second = { agentId: 'claude', label: 'Claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as const;
        const models = [{ id: 'vendor/grok-4.7', label: 'Grok 4.7' }];
        let cached = false;
        let onDiscovery: (() => void) | undefined;
        const slow = new Promise<never>(() => {});
        const onSend = vi.fn();
        const composer = await renderSessionComposer({
            replyTargets: [cursor, second], reviewEnabled: false, matchesTargetPrefix: () => false,
            resolveTargets: async () => [], resolveModels: () => slow,
            peekModels: target => cached && target === cursor ? models : null,
            subscribeModels: (_targets, onChange) => { onDiscovery = onChange; return () => {}; },
        }, onSend);
        await typeIntoComposer(composer, 'Summarize this @grok');
        await vi.waitFor(() => expect(onDiscovery).toBeTypeOf('function'));
        await act(async () => { cached = true; onDiscovery!(); });
        const row = 'agentReview:reply:@cursor/vendor%2Fgrok-4.7';
        await vi.waitFor(() => expect(findMenuRow(row)?.textContent).toContain('Grok 4.7'));
        await pressRow(composer, row);
        expect(composer.text()).toBe('@reply:cursor/vendor%2Fgrok-4.7 Summarize this');
        expect(onSend).not.toHaveBeenCalled();
    });

    it('previews a typed planner and successor before Enter dispatches both assignments', async () => {
        const claude = { agentId: 'claude', label: 'Claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as const;
        const gemini = { agentId: 'gemini', label: 'Gemini', backendTarget: { kind: 'builtInAgent', agentId: 'gemini' } } as const;
        const onSend = vi.fn();
        const composer = await renderSessionComposer({
            matchesTargetPrefix: () => false,
            resolveTargets: async () => [claude, gemini],
            resolveModels: async target => target.agentId === 'claude' ? [{ id: 'opus-test', label: 'Opus' }] : [],
        }, onSend, { currentTargetKey: 'agent:claude', successorTargets: [claude, gemini] });
        const text = '@opus plan first then @gemini take over';
        await typeIntoComposer(composer, text);
        await vi.waitFor(() => expect(document.querySelector('[data-testid="sequence-preview"]')?.textContent).toContain('Opus'));
        expect(onSend).not.toHaveBeenCalled();
        await act(async () => { composer.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
        expect(onSend).toHaveBeenCalledTimes(1);
        expect(onSend).toHaveBeenCalledWith(expect.objectContaining({
            inputTextOverride: text,
            agentSequence: [{ target: claude, modelId: 'opus-test', modelLabel: 'Opus' }, expect.objectContaining({ target: gemini, modelId: null })],
        }));
    });

    it('opens the agent menu from a cold bare @ while workspace suggestions are already available', async () => {
        const gemini = { agentId: 'gemini', label: 'Gemini', backendTarget: { kind: 'builtInAgent', agentId: 'gemini' } } as const;
        let finish!: (targets: typeof gemini[]) => void;
        const pending = new Promise<typeof gemini[]>(resolve => { finish = resolve; });
        const resolveTargets = vi.fn(() => pending);
        searchFilesMock.mockResolvedValue([file('README.md')]);
        const composer = await renderSessionComposer({
            matchesTargetPrefix: () => false, peekTargets: () => null, resolveTargets, resolveModels: async () => [],
        });
        await typeIntoComposer(composer, '@');
        await vi.waitFor(() => expect(findMenuRow('agentReview:open')).not.toBeNull());
        expect(findMenuRow('file-README.md')).not.toBeNull();
        await pressRow(composer, 'agentReview:open');
        expect(composer.text()).toBe('@agent:');
        await act(async () => { finish([gemini]); });
        await vi.waitFor(() => expect(findMenuRow('agentReview:gemini')).not.toBeNull());
    });

    it('lists agents at a bare @ and retains the picked model when adding a successor', async () => {
        const claude = { agentId: 'claude', label: 'Claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as const;
        const gemini = { agentId: 'gemini', label: 'Gemini', backendTarget: { kind: 'builtInAgent', agentId: 'gemini' } } as const;
        const onSend = vi.fn();
        const composer = await renderSessionComposer({
            matchesTargetPrefix: () => false,
            resolveTargets: async () => [claude, gemini],
            resolveModels: async target => target.agentId === 'claude' ? [{ id: 'model-a', label: 'Picked model' }] : [],
        }, onSend, { currentTargetKey: 'agent:claude', successorTargets: [claude, gemini] });
        await typeIntoComposer(composer, '@');
        await vi.waitFor(() => expect(findMenuRow('agentReview:claude')).not.toBeNull());
        await pressRow(composer, 'agentReview:claude');
        await vi.waitFor(() => expect(findMenuRow('agentReview:claude/delegate')).not.toBeNull());
        await pressRow(composer, 'agentReview:claude/delegate');
        await vi.waitFor(() => expect(findMenuRow('agentReview:claude/model-a')).not.toBeNull());
        await pressRow(composer, 'agentReview:claude/model-a');
        expect(composer.text()).toBe('@Claude ');
        await typeIntoComposer(composer, composer.text() + 'plan first then @gemini take over');
        await vi.waitFor(() => expect(document.querySelector('[data-testid="sequence-preview"]')?.textContent).toContain('Picked model'));
        expect(onSend).not.toHaveBeenCalled();
        await act(async () => { composer.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
        expect(onSend).toHaveBeenCalledWith(expect.objectContaining({
            agentSequence: [expect.objectContaining({ target: claude, modelId: 'model-a' }), expect.objectContaining({ target: gemini })],
        }));
    });

    it('sends a selected model as one foreground reply and expands a pass-to in the reply editor', async () => {
        const cursor = { agentId: 'cursor', label: 'Cursor', backendTarget: { kind: 'builtInAgent', agentId: 'cursor' } } as const;
        const codex = { agentId: 'codex', label: 'Codex', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } as const;
        const grok = { id: 'vendor/grok-special', label: 'Grok Special' };
        const onSend = vi.fn();
        const composer = await renderSessionComposer({
            replyTargets: [cursor, codex], reviewEnabled: false,
            matchesTargetPrefix: () => false, resolveTargets: async () => [],
            resolveModels: async target => target.agentId === 'cursor' ? [grok] : [],
            peekModels: target => target.agentId === 'cursor' ? [grok] : [],
        }, onSend, { currentTargetKey: 'agent:codex', successorTargets: [cursor, codex] });
        const pickModel = async () => {
            await typeIntoComposer(composer, '@grok');
            const id = 'agentReview:reply:@cursor/vendor%2Fgrok-special';
            await vi.waitFor(() => expect(findMenuRow(id)).not.toBeNull());
            await pressRow(composer, id);
        };
        const task = async (index: number) => await vi.waitFor(() => {
            const textarea = document.querySelector<HTMLTextAreaElement>(`[data-testid="composer-sequence-task-${index}"]`);
            expect(textarea).not.toBeNull();
            return textarea!;
        });
        await pickModel();
        const replyField = await task(0);
        expect(replyField.value).toBe('');
        expect(document.querySelector('[data-testid="sequence-preview"]')?.textContent).toContain('Grok Special');
        await typeIntoComposer({ textarea: replyField, text: () => replyField.value }, 'Write a math problem');
        await act(async () => { document.querySelector<HTMLElement>('[data-testid="session-composer-send"]')?.click(); });
        expect(onSend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            agentSequence: [expect.objectContaining({ target: cursor, modelId: grok.id })],
        }));
        await typeIntoComposer({ textarea: replyField, text: () => replyField.value }, 'Write a math problem and pass to @codex to solve it');
        expect((await task(1)).value).toBe('solve it');
        expect((await task(0)).value).toBe('Write a math problem');
        expect(onSend).toHaveBeenCalledTimes(1);
        await act(async () => { document.querySelector<HTMLElement>('[data-testid="session-composer-send"]')?.click(); });
        expect(onSend).toHaveBeenLastCalledWith(expect.objectContaining({
            agentSequence: [expect.objectContaining({ target: cursor, modelId: grok.id }), expect.objectContaining({ target: codex })],
        }));
    });

    it('changes agents and instructions including a return turn and submits the exact preview', async () => {
        const target = (id: 'claude' | 'codex' | 'gemini') => ({
            agentId: id, label: id, backendTarget: { kind: 'builtInAgent' as const, agentId: id },
        });
        const actors = [target('claude'), target('gemini'), target('codex')];
        const onSend = vi.fn();
        const composer = await renderSessionComposer({
            matchesTargetPrefix: () => false, resolveTargets: async () => actors,
            resolveModels: async actor => actor.agentId === 'claude' ? [{ id: 'opus', label: 'Opus' }] : [],
        }, onSend, { currentTargetKey: 'agent:claude', successorTargets: actors });
        const click = async (id: string) => {
            const element = await vi.waitFor(() => {
                const found = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
                expect(found).not.toBeNull();
                return found!;
            });
            await act(async () => { element.click(); });
        };
        await typeIntoComposer(composer, '@opus plan first then @gemini take over, then back to @claude to revise');
        await click('composer-sequence-agent-0');
        await click('composer-sequence-option-@codex');
        await vi.waitFor(() => expect(composer.text()).toBe('@codex plan first then @gemini take over, then back to @claude to revise'));
        await click('composer-sequence-agent-1');
        await click('composer-sequence-option-@claude/opus');
        await vi.waitFor(() => expect(composer.text()).toBe('@codex plan first then @claude/opus take over, then back to @claude to revise'));
        const third = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-sequence-task-2"]')!;
        expect(third.value).toBe('revise');
        await typeIntoComposer({ text: () => third.value, textarea: third }, 'polish the summary');
        await vi.waitFor(() => expect(composer.text()).toContain('@claude to polish the summary'));
        await click('composer-sequence-add');
        await vi.waitFor(() => expect(composer.text()).toMatch(/, then @$/));
        await click('session-composer-send');
        expect(onSend).not.toHaveBeenCalled();
        await click('composer-sequence-order-3');
        await click('composer-sequence-remove');
        await click('composer-sequence-order-2');
        await click('composer-sequence-up');
        await vi.waitFor(() => expect(composer.text()).toBe('@codex plan first, then @claude polish the summary, then @claude/opus take over'));
        expect(onSend).not.toHaveBeenCalled();
        await click('session-composer-send');
        expect(onSend).toHaveBeenCalledWith(expect.objectContaining({
            inputTextOverride: composer.text(), agentSequence: [expect.objectContaining({ target: actors[2] }), expect.objectContaining({ target: actors[0], modelId: null }), expect.objectContaining({ target: actors[0], modelId: 'opus' })],
        }));
    });

    it('previews a typed pass without picking a menu action and sends only the two visible assignments', async () => {
        const lead = { agentId: 'claude', label: 'Claude', backendTarget: {kind: 'builtInAgent', agentId: 'claude'} } as const;
        const next = { agentId: 'codex', label: 'Codex', backendTarget: {kind: 'builtInAgent', agentId: 'codex'} } as const;
        const onSend = vi.fn();
        const composer = await renderSessionComposer(undefined, onSend, {
            currentTargetKey: 'agent:claude', currentModelId: 'catalog-model', successorTargets: [lead, next],
            resolveModels: async () => [{id: 'catalog-model', label: 'Selected model'}],
        });
        const text = 'Generate a math problem and pass to @codex';
        await typeIntoComposer(composer, text);
        const row = (i: number) => document.querySelector<HTMLTextAreaElement>('[data-testid="composer-sequence-task-' + i + '"]')?.value;
        await vi.waitFor(() => expect(document.querySelector('[data-testid="sequence-preview"]')?.textContent).toContain('Selected model'));
        expect(row(0)).toBe('Generate a math problem');
        expect(row(1)).toBe('agentInput.sequence.takeOverTask');
        expect(onSend).not.toHaveBeenCalled();
        await act(async () => { document.querySelector<HTMLElement>('[data-testid="session-composer-send"]')?.click(); });
        expect(onSend).toHaveBeenCalledWith(expect.objectContaining({
            inputTextOverride: text, agentSequence: [expect.objectContaining({target: lead, modelId: 'catalog-model'}), expect.objectContaining({target: next, modelId: null})],
        }));
    });

    it.each([
        ['cursor', 'codex'],
        ['gemini', 'claude'],
    ] as const)('stages %s → %s from the agent menu and sends only after preview', async (firstId, nextId) => {
        const source = { agentId: firstId, label: firstId, backendTarget: { kind: 'builtInAgent', agentId: firstId } } as const;
        const target = { agentId: nextId, label: nextId, backendTarget: { kind: 'builtInAgent', agentId: nextId } } as const;
        const onSend = vi.fn();
        const onStage = vi.fn();
        const composer = await renderSessionComposer({
            matchesTargetPrefix: query => nextId.startsWith(query),
            resolveTargets: async () => [],
            resolveModels: async () => [{ id: 'selected-model', label: 'Chosen model' }],
            reviewEnabled: false,
            handoff: {
                first: { target: source, modelId: 'selected-model', modelLabel: 'Chosen model' },
                targets: [source, target],
                onStage,
            },
        }, onSend, { currentTargetKey: 'agent:' + firstId, successorTargets: [source, target] });
        await typeIntoComposer(composer, 'Write a short math question and hand over to @' + nextId);
        await vi.waitFor(() => expect(findMenuRow('agentReview:' + nextId)).not.toBeNull());
        await pressRow(composer, 'agentReview:' + nextId);
        await vi.waitFor(() => expect(findMenuRow('agentReview:' + nextId + '/handoff')).not.toBeNull());
        expect(findMenuRow('agentReview:' + nextId + '/selected-model')).toBeNull();
        await pressRow(composer, 'agentReview:' + nextId + '/handoff');
        await vi.waitFor(() => expect(document.querySelector('[data-testid="sequence-preview"]')?.textContent).toContain('Chosen model'));
        expect(document.querySelector<HTMLTextAreaElement>('[data-testid="composer-sequence-task-0"]')?.value).toBe('Write a short math question');
        expect(onStage).toHaveBeenCalledTimes(1);
        expect(onSend).not.toHaveBeenCalled();
        await act(async () => { document.querySelector<HTMLElement>('[data-testid="session-composer-send"]')?.click(); });
        expect(onSend).toHaveBeenCalledWith(expect.objectContaining({
            agentSequence: [expect.objectContaining({ target: source, modelId: 'selected-model' }), expect.objectContaining({ target, modelId: null })],
        }));
    });

    it('chooses an agent and model by keyboard, preserves instructions and submits the explicit reviewer', async () => {
        const codex = { agentId: 'codex', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, label: 'Codex' } as const;
        const gemini = { agentId: 'gemini', backendTarget: { kind: 'builtInAgent', agentId: 'gemini' }, label: 'Gemini' } as const;
        const resolveModels = vi.fn(async () => [{ id: null, label: 'Default' }, { id: 'review-model', label: 'Review model' }]);
        const onSend = vi.fn();
        const composer = await renderSessionComposer({ matchesTargetPrefix: query => [codex, gemini].some(target => target.label.toLowerCase().startsWith(query.toLowerCase())), resolveTargets: async () => [codex, gemini], resolveModels }, onSend);
        const press = async (key: string) => {
            await act(async () => { composer.textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
        };
        await typeIntoComposer(composer, 'Check the draft @agent');
        await vi.waitFor(() => expect(findMenuRow('agentReview:gemini')).not.toBeNull());
        await press('ArrowDown');
        await press('Enter');
        expect(composer.text()).toBe('Check the draft @agent:gemini/');
        await vi.waitFor(() => expect(findMenuRow('agentReview:gemini/delegate')).not.toBeNull());
        expect(findMenuRow('agentReview:gemini/review-model')).toBeNull();
        expect(resolveModels).not.toHaveBeenCalled();
        await press('Tab');
        expect(composer.text()).toBe('Check the draft @agent:gemini/delegate/');
        await vi.waitFor(() => expect(findMenuRow('agentReview:gemini/review-model')).not.toBeNull());
        await press('ArrowDown');
        await press('Tab');
        expect(composer.text()).toBe('Check the draft @Gemini ');
        expect(onSend).not.toHaveBeenCalled();
        const chip = document.querySelector<HTMLElement>('[data-testid="agent-input-reviewer"]');
        expect(chip?.textContent).toContain('Review model');
        await press('Enter');
        expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ agentReviewSelection: { target: gemini, modelId: 'review-model', modelLabel: 'Review model' } }));
        await act(async () => { chip?.click(); });
        expect(composer.text()).toBe('Check the draft ');
        expect(document.querySelector('[data-testid="agent-input-reviewer"]')).toBeNull();
    });

    it.each([['@clau', 'claude'], ['@gemini', 'gemini']] as const)('opens %s directly in the session composer', async (query, agentId) => {
        const target = { agentId, label: agentId, backendTarget: { kind: 'builtInAgent', agentId } } as const;
        const resolveModels = vi.fn(async () => [{ id: 'test-model', label: 'Test model' }]);
        const composer = await renderSessionComposer({ matchesTargetPrefix: value => agentId.startsWith(value),
            resolveTargets: async () => [target], resolveModels });
        await typeIntoComposer(composer, 'Look at this ' + query);
        await vi.waitFor(() => expect(findMenuRow('agentReview:' + agentId)).not.toBeNull());
        await pressRow(composer, 'agentReview:' + agentId);
        await vi.waitFor(() => expect(findMenuRow('agentReview:' + agentId + '/delegate')).not.toBeNull());
        await pressRow(composer, 'agentReview:' + agentId + '/delegate');
        await vi.waitFor(() => expect(findMenuRow('agentReview:' + agentId + '/test-model')).not.toBeNull());
        await pressRow(composer, 'agentReview:' + agentId + '/test-model');
        expect(composer.text()).toBe('Look at this @' + agentId + ' ');
        expect(document.querySelector('[data-testid="agent-input-reviewer"]')?.textContent).toContain('Test model');
    });

    it('commits a file suggestion without the press stealing composer focus', async () => {
        searchFilesMock.mockResolvedValue([file('README.md'), file('docs/README.md')]);

        const composer = await renderSessionComposer();
        await typeIntoComposer(composer, '@REA');

        expect(findMenuRow('file-README.md')).not.toBeNull();

        const press = await pressRow(composer, 'file-README.md');

        expect(press.pointerDownCancelled).toBe(true);
        expect(press.clickDelivered).toBe(true);
        expect(document.activeElement).toBe(composer.textarea);
        expect(composer.text()).toBe('@README.md ');
        // The caret lands just past the inserted token and its trailing space, so the
        // next keystroke continues the message. Nothing pinned this: replacing the
        // host's `result.cursorPosition` with `0` — which would drop every subsequent
        // keystroke at the start of the composer — left the whole corridor green.
        expect(composer.textarea.selectionStart).toBe('@README.md '.length);
        expect(composer.textarea.selectionEnd).toBe('@README.md '.length);
    });

    // The other half of the same contract. `CommandMenuSurface` cancels the
    // pointer-down default precisely BECAUSE losing composer focus drops the query
    // and unmounts the row — but nothing asserted that losing focus does close the
    // picker, so the gate could be deleted (which "fixes" the press bug) while
    // leaving a picker open over a composer that no longer has focus. Deleting
    // `isInputFocused` from `activeSuggestionQuery` left the whole corridor green.
    it('closes the picker when the composer loses focus', async () => {
        searchFilesMock.mockResolvedValue([file('README.md')]);

        const composer = await renderSessionComposer();
        await typeIntoComposer(composer, '@REA');

        expect(findMenuRow('file-README.md')).not.toBeNull();

        await act(async () => {
            composer.textarea.blur();
        });
        await act(async () => {});

        expect(findMenuRow('file-README.md')).toBeNull();
    });

    // The picker highlights the first row; a press must commit the row under the
    // pointer, not the highlighted one. `CommandMenu` resolves the pressed row's
    // index from its own item list and the host applies THAT index.
    it('commits the row that was pressed, not the highlighted one', async () => {
        searchFilesMock.mockResolvedValue([file('README.md'), file('docs/README.md')]);

        const composer = await renderSessionComposer();
        await typeIntoComposer(composer, '@REA');

        await pressRow(composer, 'file-docs/README.md');

        expect(composer.text()).toBe('@docs/README.md ');
    });

    // D-20: a prompt-template command replaces the ENTIRE input, through the kind's
    // own `applySelection`, not through token substitution. This is the second
    // reported P0 symptom ("selecting a prompt template does nothing") and it is a
    // different branch of `handleSuggestionSelect` from the file case above.
    it('expands a prompt-template slash command over the whole input', async () => {
        searchCommandsMock.mockResolvedValue([{
            command: 'detailed-plan',
            promptInvocation: {
                invocationId: 'inv-1',
                token: 'detailed-plan',
                targetArtifactId: PROMPT_ARTIFACT_ID,
                behavior: 'insert',
                allowArgs: false,
            },
        }]);

        const composer = await renderSessionComposer();
        await typeIntoComposer(composer, '/detai');

        const press = await pressRow(composer, 'cmd-detailed-plan');

        expect(press.clickDelivered).toBe(true);
        expect(composer.text()).toBe(PROMPT_TEMPLATE_TEXT);
    });
});
