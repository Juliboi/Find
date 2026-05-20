import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/theme/useTheme';

interface Props {
  title: string;
  body?: string;
  action?: React.ReactNode;
}

export function EmptyState({ title, body, action }: Props) {
  const { colors } = useTheme();
  return (
    <View style={styles.container}>
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      {body ? (
        <Text style={[styles.body, { color: colors.textMuted }]}>{body}</Text>
      ) : null}
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 48,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  body: {
    fontSize: 15,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 22,
  },
  action: {
    marginTop: 24,
    width: '100%',
  },
});
