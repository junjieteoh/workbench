import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export type ComposerSequenceStep = Readonly<{ agentKey: string; agentLabel: string; task: string }>;
export type ComposerSequenceOption = Readonly<{ key: string; label: string }>;

type Props = Readonly<{
    steps: readonly [ComposerSequenceStep, ComposerSequenceStep];
    options: readonly ComposerSequenceOption[];
    optionsByStep?: readonly [readonly ComposerSequenceOption[], readonly ComposerSequenceOption[]];
    onAgentChange: (stepIndex: 0 | 1, key: string) => void;
    status?: string;
    disabled?: boolean;
}>;

function SequenceStep({ step, index, options, disabled, onAgentChange }: Readonly<{
    step: ComposerSequenceStep;
    index: 0 | 1;
    options: readonly ComposerSequenceOption[];
    disabled?: boolean;
    onAgentChange: Props['onAgentChange'];
}>) {
    const { theme } = useUnistyles();
    const label = index === 0 ? t('agentInput.sequence.planOnly') : t('agentInput.sequence.takesOver');
    const [open, setOpen] = React.useState(false);
    const trigger = React.useRef<React.ElementRef<typeof View>>(null);
    const canEdit = !disabled && options.length > 0;
    const items = React.useMemo(() => options.map(option => ({
        id: option.key, title: option.label, testID: `composer-sequence-option-${option.key}`,
    })), [options]);
    React.useEffect(() => {
        if (!canEdit) setOpen(false);
    }, [canEdit]);
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
                            accessibilityLabel={t('agentInput.sequence.changeAgent', { step: label, agent: step.agentLabel })}
                            accessibilityState={{ disabled: !canEdit, expanded: canEdit && open }}
                            disabled={!canEdit}
                            hitSlop={4}
                            onPress={toggle}
                            style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}
                        >
                            <Text numberOfLines={1} style={styles.agentName}>{step.agentLabel}</Text>
                            {canEdit && <Icon name="caret-down" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}
                        </Pressable>
                    )}
                />
            </View>
            <Text numberOfLines={2} style={styles.task}>{step.task}</Text>
        </View>
    );
}

export function ComposerSequencePreview({ steps, options, optionsByStep, onAgentChange, status, disabled }: Props) {
    return (
        <View testID="sequence-preview" style={styles.preview}>
            {([0, 1] as const).map(index => (
                <SequenceStep key={index} step={steps[index]} index={index} options={optionsByStep?.[index] ?? options}
                    onAgentChange={onAgentChange} disabled={disabled} />
            ))}
            {status ? <Text accessibilityLiveRegion="polite" style={styles.status}>{status}</Text> : null}
        </View>
    );
}

const styles = StyleSheet.create(theme => ({
    preview: { paddingHorizontal: 12, paddingVertical: 4, gap: 2 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
    stageLabel: { ...Typography.rowMeta(), color: theme.colors.text.secondary, width: '20%', maxWidth: 85 },
    agent: { maxWidth: '44%', flexShrink: 1 },
    trigger: {
        flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 5,
        minHeight: 36, borderRadius: 8, backgroundColor: theme.colors.surface.elevated,
    },
    pressed: { backgroundColor: theme.colors.surface.pressed },
    agentName: { ...Typography.rowMeta(), ...Typography.default('semiBold'), color: theme.colors.text.primary, flexShrink: 1 },
    task: { ...Typography.rowMeta(), color: theme.colors.text.primary, flex: 1, minWidth: 0 },
    status: { ...Typography.rowMeta(), color: theme.colors.text.secondary },
}));
