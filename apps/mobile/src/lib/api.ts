import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { createClient, validateApiUrl } from './client';

// Web export is a review surface; native is the shipped client. Browser preview
// sessions are memory-only. Key by backend so preview and production cannot mix.
let browserToken: string | null = null;
export function initializeApi() {
  const origin = validateApiUrl(process.env.EXPO_PUBLIC_API_URL, __DEV__);
  const key = `towncivic.${origin.replace(/[^a-zA-Z0-9._-]/g, '_')}.session`;
  return createClient(origin, {
    get: () => (Platform.OS === 'web' ? Promise.resolve(browserToken) : SecureStore.getItemAsync(key)),
    set: async (value) => {
      if (Platform.OS === 'web') browserToken = value;
      else await SecureStore.setItemAsync(key, value);
    },
    clear: async () => {
      if (Platform.OS === 'web') browserToken = null;
      else await SecureStore.deleteItemAsync(key);
    },
  });
}
