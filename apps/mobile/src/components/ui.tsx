import type { PropsWithChildren } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useState } from 'react';

export const colors = {
  ink: '#172F35',
  muted: '#586F72',
  accent: '#176D63',
  pale: '#E4F0EC',
  paper: '#F6F8F5',
  white: '#FFFFFF',
  line: '#D9E3DF',
  warning: '#805300',
};
export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  padded: { padding: 20, gap: 14 },
  title: { fontSize: 28, fontWeight: '700', color: colors.ink },
  heading: { fontSize: 19, fontWeight: '600', color: colors.ink },
  text: { fontSize: 17, lineHeight: 26, color: colors.ink },
  muted: { fontSize: 14, lineHeight: 21, color: colors.muted },
  label: { fontSize: 12, fontWeight: '700', color: colors.accent, letterSpacing: 1 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  card: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 16,
    padding: 18,
    gap: 9,
    marginBottom: 12,
  },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    backgroundColor: colors.white,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 17,
    color: colors.ink,
  },
  button: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: colors.pale,
    justifyContent: 'center',
  },
});
export function Button({
  title,
  onPress,
  disabled,
  selected = false,
}: {
  title: string;
  onPress(): void;
  disabled?: boolean;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      onPress={onPress}
      disabled={disabled}
      style={[styles.button, selected && { backgroundColor: colors.accent }, disabled && { opacity: 0.5 }]}
    >
      <Text style={{ color: selected ? colors.white : colors.accent, fontSize: 15, fontWeight: '600' }}>
        {title}
      </Text>
    </Pressable>
  );
}
export function Screen({ children }: PropsWithChildren) {
  return (
    <SafeAreaView style={styles.screen} edges={['left', 'right']}>
      {children}
    </SafeAreaView>
  );
}
export function Message({
  title,
  detail,
  retry,
  loading,
}: {
  title: string;
  detail?: string;
  retry?: () => void;
  loading?: boolean;
}) {
  return (
    <View style={[styles.padded, { flex: 1, justifyContent: 'center', alignItems: 'center' }]}>
      {loading && <ActivityIndicator size="large" color={colors.accent} />}
      <Text style={styles.heading} accessibilityRole="header">
        {title}
      </Text>
      {!!detail && <Text style={[styles.muted, { textAlign: 'center' }]}>{detail}</Text>}
      {retry && <Button title="Try again" onPress={retry} />}
    </View>
  );
}
export function SampleNotice({ visible }: { visible?: boolean }) {
  return visible ? (
    <Text style={[styles.muted, { color: colors.warning }]}>
      Sample records — these are testing fixtures.
    </Text>
  ) : null;
}
export function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        title={`${label}: ${options.find((o) => o.value === value)?.label ?? value} ▾`}
        onPress={() => setOpen(true)}
      />
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <SafeAreaView style={styles.screen}>
          <View style={styles.padded}>
            <Text style={styles.title}>{label}</Text>
            <Button title="Done" onPress={() => setOpen(false)} />
          </View>
          <ScrollView contentContainerStyle={styles.padded}>
            {options.map((o) => (
              <Button
                key={o.value}
                title={o.label}
                selected={o.value === value}
                onPress={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              />
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}
export function openUrl(value: string) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported source link');
    void Linking.openURL(url.href).catch(() => Alert.alert('Unable to open link', 'Please try again.'));
  } catch {
    Alert.alert('Unable to open link', 'This record has an unsupported source address.');
  }
}
export const dateLabel = (value: string | null) =>
  value
    ? new Date(value).toLocaleDateString('en-US', {
        timeZone: 'America/New_York',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '';
export function timestamp(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(seconds % 60).padStart(2, '0')}`;
}
