import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ComposerSequenceOrderChange } from './composerAgentSequence';

export type ComposerSequenceStep = Readonly<{ agentKey: string; agentLabel: string; task: string }>;
export type ComposerSequenceOption = Readonly<{ key: string; label: string }>;

type Props = Readonly<{
    steps: readonly ComposerSequenceStep[];
    options: readonly ComposerSequenceOption[];
    onAgentChange: (stepIndex: number, key: string) => void;
    onTaskChange: (stepIndex: number, instructions: string) => void;
    onOrderChange: (change: ComposerSequenceOrderChange) => void;
    status?: string;
    disabled?: boolean;
}>;

function SequenceStep({ step, index, count, options, disabled, onAgentChange, onTaskChange, onOrderChange }: Readonly<{
    step: ComposerSequenceStep;
    index: number;
    count: number;
    onOrderChange: Props['onOrderChange'];
    options: readonly ComposerSequenceOption[];
    disabled?: boolean;
    onAgentChange: Props['onAgentChange'];
    onTaskChange: Props['onTaskChange'];
}>) {
    const { theme } = useUnistyles();
    const label = t('agentInput.sequence.turn', { index: index + 1 });
    const agentLabel = step.agentLabel === '@' ? t('agentInput.agentReview.choose') : step.agentLabel;
    const [open, setOpen] = React.useState(false);
    const [orderOpen, setOrderOpen] = React.useState(false);
    const trigger = React.useRef<React.ElementRef<typeof View>>(null);
    const canEdit = !disabled && options.length > 0;
    const items = React.useMemo(() => options.map(option => ({
        id: option.key, title: option.label, testID: `composer-sequence-option-${option.key}`,
    })), [options]);
    React.useEffect(() => {
        if (!canEdit) setOpen(false);
        if (disabled) setOrderOpen(false);
    }, [canEdit, disabled]);
    return (
        <View style={styles.row}>
            <Text style={styles.stageLabel}>{label}</Text>
            <View style={styles.agent}>
                <DropdownMenu
                    open={canEdit && open}
                    onOpenChange={setOpen}
                    selectedId={step.agentKey}
                    items={items}
                    onSelect={key => {
                        onAgentChange(index, key);
                        if (Platform.OS === 'web') trigger.current?.focus();
                    }}
                    variant="slim"
                    matchTriggerWidth={false}
                    placement="auto-vertical"
                    trigger={({ toggle }) => (
                        <Pressable
                            ref={trigger}
                            testID={`composer-sequence-agent-${index}`}
                            accessibilityRole="button"
                            accessibilityLabel={t('agentInput.sequence.changeAgent', { step: label, agent: agentLabel })}
                            accessibilityState={{ disabled: !canEdit, expanded: canEdit && open }}
                            disabled={!canEdit}
                            hitSlop={4}
                            onPress={toggle}
                            style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}
                        >
                            <Text numberOfLines={1} style={styles.agentName}>{agentLabel}</Text>
                            {canEdit && <Icon name="caret-down" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}
                        </Pressable>
                    )}
                />
            </View>
            <TextInput
                testID={`composer-sequence-task-${index}`}
                accessibilityLabel={label + ' · ' + t('executionRuns.newRun.sections.instructions')}
                placeholder={t('executionRuns.newRun.sections.instructions')}
                placeholderTextColor={theme.colors.text.secondary}
                editable={!disabled}
                multiline
                value={step.task}
                onChangeText={value => onTaskChange(index, value)}
                style={styles.task}
            />
            <DropdownMenu
                open={!disabled && orderOpen}
                onOpenChange={setOrderOpen}
                variant="slim" placement="auto-vertical" matchTriggerWidth={false}
                items={[
                    ...(index > 0 ? [{ id: 'up', title: t('common.moveUp'), testID: 'composer-sequence-up' }] : []),
                    ...(index + 1 < count ? [{ id: 'down', title: t('common.moveDown'), testID: 'composer-sequence-down' }] : []),
                    ...(count > 2 ? [{ id: 'remove', title: t('common.remove'), testID: 'composer-sequence-remove' }] : []),
                ]}
                onSelect={kind => {
                    if (kind === 'up' || kind === 'down' || kind === 'remove') onOrderChange({ kind, index });
                }}
                trigger={({ toggle }) => (
                    <Pressable accessibilityRole="button" accessibilityLabel={label + ' · ' + t('common.moreActions')}
                        accessibilityState={{ expanded: orderOpen, disabled }} disabled={disabled}
                        testID={`composer-sequence-order-${index}`} onPress={toggle} style={styles.orderTrigger}>
                        <Icon name="dots-three" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
                    </Pressable>
                )}
            />
        </View>
    );
}

export function ComposerSequencePreview({ steps, options, onAgentChange, onTaskChange, onOrderChange, status, disabled }: Props) {
    return (
        <View testID="sequence-preview" style={styles.preview}>
            <ScrollView keyboardShouldPersistTaps="handled" style={styles.rows}>
                {steps.map((step, index) => (
                <SequenceStep key={index} step={step} index={index} options={options} count={steps.length} onOrderChange={onOrderChange}
                    onAgentChange={onAgentChange} onTaskChange={onTaskChange} disabled={disabled} />
                ))}
            </ScrollView>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
                onPress={() => onOrderChange({ kind: 'add' })} testID="composer-sequence-add" style={styles.addTrigger}>
                <Text style={styles.stageLabel}>{t('agentInput.sequence.addTurn')}</Text>
            </Pressable>
            {status ? <Text accessibilityLiveRegion="polite" style={styles.status}>{status}</Text> : null}
        </View>
    );
}

const styles = StyleSheet.create(theme => ({
    preview: { paddingHorizontal: 12, paddingVertical: 4, gap: 2 },
    rows: { maxHeight: 200 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
    stageLabel: { ...Typography.rowMeta(), color: theme.colors.text.secondary, flexShrink: 0 },
    agent: { maxWidth: '44%', flexShrink: 1 },
    trigger: {
        flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 5,
        minHeight: Platform.OS === 'web' ? 36 : 48, borderRadius: 8, backgroundColor: theme.colors.surface.elevated,
    },
    pressed: { backgroundColor: theme.colors.surface.pressed },
    agentName: { ...Typography.rowMeta(), ...Typography.default('semiBold'), color: theme.colors.text.primary, flexShrink: 1 },
    task: { ...Typography.rowMeta(), color: theme.colors.text.primary, flex: 1, minWidth: 0, minHeight: Platform.OS === 'web' ? 36 : 48, paddingHorizontal: 6, paddingVertical: 7 },
    orderTrigger: { minWidth: Platform.OS === 'web' ? 32 : 48, minHeight: Platform.OS === 'web' ? 36 : 48, alignItems: 'center', justifyContent: 'center' },
    addTrigger: { alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 6, minHeight: Platform.OS === 'web' ? 32 : 48 },
    status: { ...Typography.rowMeta(), color: theme.colors.text.secondary },
}));
