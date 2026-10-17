import type { ExpoConfig } from 'expo/config';

// Run `eas init` once, then set these non-secret identifiers in this config or
// the build environment. Never put backend secrets in EXPO_PUBLIC_* variables.
const projectId = process.env.EAS_PROJECT_ID;
const bundleIdentifier = process.env.TOWNCIVIC_BUNDLE_ID ?? 'org.towncivic.reader';
const profile = process.env.EAS_BUILD_PROFILE;
if (profile === 'testflight' || profile === 'production') {
  const endpoint = process.env.EXPO_PUBLIC_API_URL;
  if (!endpoint || !/^https:\/\//.test(endpoint)) {
    throw new Error('Store builds require EXPO_PUBLIC_API_URL pointing to an HTTPS backend with /api/v1.');
  }
}

const config: ExpoConfig = {
  name: 'TownCivic',
  slug: 'towncivic',
  version: '0.1.0',
  scheme: 'towncivic',
  orientation: 'default',
  userInterfaceStyle: 'light',
  icon: './assets/icon.png',
  ios: {
    supportsTablet: true,
    bundleIdentifier,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: { package: bundleIdentifier },
  web: { bundler: 'metro', output: 'single', favicon: './assets/favicon.png' },
  plugins: ['expo-router', 'expo-secure-store'],
  ...(projectId ? { extra: { eas: { projectId } } } : {}),
};
export default config;
