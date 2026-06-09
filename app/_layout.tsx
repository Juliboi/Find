import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/useTheme';

export default function RootLayout() {
  const { colors, scheme } = useTheme();
  return (
    <GestureHandlerRootView
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <SafeAreaProvider>
        <BottomSheetModalProvider>
          <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
              animation: 'slide_from_right',
            }}
          >
            <Stack.Screen name="index" />
            <Stack.Screen name="plans" />
            <Stack.Screen name="places" />
            <Stack.Screen name="settings" />
            <Stack.Screen
              name="add"
              options={{
                presentation: 'modal',
                animation: 'slide_from_bottom',
                contentStyle: { backgroundColor: colors.background },
              }}
            />
            <Stack.Screen name="test" />
            <Stack.Screen name="itinerary" />
          </Stack>
        </BottomSheetModalProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
