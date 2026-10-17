import { useCallback, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import type { Following, MatterDetail } from '@towncivic/api-contracts';
import { useApp, useResource, errorMessage } from '../../lib/state';
import { EventCard } from '../../components/Browse';
import { Button, Message, SampleNotice, Screen, styles } from '../../components/ui';

export default function MatterScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <MatterReader key={id} id={id} />;
}
function MatterReader({ id }: { id: string }) {
  const { api, session } = useApp();
  const { data, loading, error, retry } = useResource<MatterDetail>(`/matters/${encodeURIComponent(id)}`);
  const [followed, setFollowed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setFollowed(null);
      setProblem('');
      if (session)
        api
          .authenticated<Following>('/following')
          .then((result) => {
            if (active) setFollowed(result.items.some((m) => m.id === id));
          })
          .catch((e) => {
            if (active) setProblem(errorMessage(e));
          });
      return () => {
        active = false;
      };
    }, [api, session, id]),
  );
  async function toggle() {
    if (!session) {
      router.push('/account');
      return;
    }
    setBusy(true);
    setProblem('');
    try {
      await api.authenticated(`/following/${encodeURIComponent(id)}`, followed ? 'DELETE' : 'PUT');
      setFollowed(!followed);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <Message
        title={loading ? 'Opening timeline…' : 'Unable to open timeline'}
        detail={error}
        loading={loading}
        retry={retry}
      />
    );
  return (
    <Screen>
      <FlatList
        data={data.events}
        keyExtractor={(e) => e.id}
        contentContainerStyle={[styles.padded, { maxWidth: 900, width: '100%', alignSelf: 'center' }]}
        ListHeaderComponent={
          <View style={{ gap: 14, marginBottom: 20 }}>
            <SampleNotice visible={data.sampleData} />
            <Text style={styles.label}>
              {data.kind.toUpperCase()} · {data.eventCount} RECORDS
            </Text>
            <Text style={styles.title}>{data.label}</Text>
            <Text style={styles.muted}>
              Linked by the records’ subject text. Stages are derived from wording, not legal determinations.
            </Text>
            <Button
              title={
                !session
                  ? 'Sign in to follow'
                  : busy
                    ? 'Saving…'
                    : followed
                      ? 'Following · unfollow'
                      : 'Follow this timeline'
              }
              selected={followed === true}
              disabled={busy || (!!session && followed === null && !problem)}
              onPress={() => void toggle()}
            />
            {!!problem && <Text style={styles.muted}>{problem}</Text>}
          </View>
        }
        renderItem={({ item }) => (
          <View>
            <Text style={[styles.label, { marginBottom: 8 }]}>{item.stage.toUpperCase()}</Text>
            {!!item.evidence && <Text style={[styles.muted, { marginBottom: 8 }]}>{item.evidence}</Text>}
            <EventCard
              item={item}
              onPress={() => router.push({ pathname: '/event/[id]', params: { id: item.id } })}
            />
          </View>
        )}
      />
    </Screen>
  );
}
