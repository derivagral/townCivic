import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import type { Following } from '@towncivic/api-contracts';
import { useApp, errorMessage } from '../../lib/state';
import { Button, Screen, colors, styles } from '../../components/ui';

export default function Account() {
  const { api, session, refreshSession } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [following, setFollowing] = useState<Following | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      setFollowing(null);
      setError('');
      if (session)
        api
          .authenticated<Following>('/following')
          .then((value) => {
            if (active) setFollowing(value);
          })
          .catch((e) => {
            if (active) setError(errorMessage(e));
          });
      return () => {
        active = false;
      };
    }, [api, session]),
  );
  async function signIn() {
    setBusy(true);
    setError('');
    try {
      await api.signIn(email.trim(), password);
      setPassword('');
      await refreshSession();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    setError('');
    try {
      await api.signOut();
      await refreshSession();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Screen>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={100}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.padded, { maxWidth: 650, width: '100%', alignSelf: 'center' }]}
        >
          <Text style={styles.title}>{session ? `Hello, ${session.name}` : 'Your TownCivic'}</Text>
          {session ? (
            <>
              <Text style={styles.muted}>{session.email}</Text>
              <Button
                title={busy ? 'Signing out…' : 'Sign out'}
                disabled={busy}
                onPress={() => void signOut()}
              />
              <Text style={[styles.heading, { marginTop: 16 }]}>Followed timelines</Text>
              <Text style={styles.muted}>
                Your follows are shared with the website. Following saves a timeline; notifications are not
                enabled yet.
              </Text>
              {following?.items.map((m) => (
                <Button
                  key={m.id}
                  title={`${m.label} · ${m.eventCount} records →`}
                  onPress={() => router.push({ pathname: '/matter/[id]', params: { id: m.id } })}
                />
              ))}
              {following && !following.items.length && (
                <Text style={styles.muted}>Open an issue timeline and tap Follow to keep it here.</Text>
              )}
              {!following && !error && <Text style={styles.muted}>Loading your timelines…</Text>}
              <Button
                title="Refresh follows"
                onPress={() => {
                  setError('');
                  api
                    .authenticated<Following>('/following')
                    .then(setFollowing)
                    .catch((e) => setError(errorMessage(e)));
                }}
              />
            </>
          ) : (
            <>
              <Text style={styles.text}>
                Read every public record without an account. Sign in with your existing TownCivic account to
                follow issue timelines.
              </Text>
              <Text style={styles.muted}>
                This first beta supports existing accounts. Account creation and password recovery remain on
                the website.
              </Text>
              <TextInput
                accessibilityLabel="Email"
                textContentType="username"
                autoComplete="email"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Email address"
                placeholderTextColor={colors.muted}
                value={email}
                onChangeText={setEmail}
                style={styles.input}
              />
              <TextInput
                accessibilityLabel="Password"
                textContentType="password"
                autoComplete="current-password"
                secureTextEntry
                placeholder="Password"
                placeholderTextColor={colors.muted}
                value={password}
                onChangeText={setPassword}
                style={styles.input}
                onSubmitEditing={() => {
                  if (!busy) void signIn();
                }}
              />
              <Button
                title={busy ? 'Signing in…' : 'Sign in'}
                disabled={busy || !email.trim() || !password}
                onPress={() => void signIn()}
              />
            </>
          )}
          {!!error && (
            <View accessibilityLiveRegion="polite">
              <Text style={styles.text}>{error}</Text>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
