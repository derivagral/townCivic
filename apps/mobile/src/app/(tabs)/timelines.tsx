import { useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import type { MatterSummary, Page } from '@towncivic/api-contracts';
import { useApp, useResource } from '../../lib/state';
import { Button, Message, SampleNotice, Screen, colors, dateLabel, styles } from '../../components/ui';
import { TownSelect } from '../../components/Browse';

export default function Timelines() {
  const { town } = useApp();
  return <TownTimelines key={town} town={town} />;
}
function TownTimelines({ town }: { town: string }) {
  const [draft, setDraft] = useState('');
  const [q, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const { data, loading, error, retry } = useResource<Page<MatterSummary>>(
    `/matters?${new URLSearchParams({ town, q, page: String(page) })}`,
  );
  const search = () => {
    setQuery(draft.trim());
    setPage(1);
  };
  return (
    <Screen>
      <FlatList
        data={data?.items ?? []}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.padded}
        refreshing={loading}
        onRefresh={retry}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 20 }}>
            <Text style={styles.title}>Follow an issue</Text>
            <Text style={styles.muted}>
              See how a property, warrant article or procurement moves through town government.
            </Text>
            <TownSelect />
            <View style={styles.row}>
              <TextInput
                accessibilityLabel="Search timeline labels"
                placeholder="Address, article or procurement…"
                placeholderTextColor={colors.muted}
                value={draft}
                onChangeText={setDraft}
                onSubmitEditing={search}
                returnKeyType="search"
                style={[styles.input, { flex: 1 }]}
                maxLength={300}
              />
              <Button title="Search" onPress={search} />
            </View>
            <SampleNotice visible={data?.sampleData} />
            <Text style={styles.muted}>
              Timelines with two or more records. Search matches timeline labels.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/matter/[id]', params: { id: item.id } })}
            style={styles.card}
          >
            <Text style={styles.label}>
              {item.kind.toUpperCase()} · {item.eventCount} RECORDS
            </Text>
            <Text style={styles.heading}>{item.label}</Text>
            <Text style={styles.muted}>
              {item.status ?? 'In the record'} · {dateLabel(item.lastAt)}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          <Message
            title={loading ? 'Loading timelines…' : error ? 'Unable to load timelines' : 'No timelines found'}
            detail={error || 'Try a different town or search.'}
            loading={loading}
            retry={error ? retry : undefined}
          />
        }
        ListFooterComponent={
          data ? (
            <View style={styles.row}>
              <Button title="Previous" disabled={page === 1} onPress={() => setPage((p) => p - 1)} />
              <Text style={styles.muted}>Page {page}</Text>
              <Button title="Next" disabled={!data.nextPage} onPress={() => setPage(data.nextPage!)} />
            </View>
          ) : null
        }
      />
    </Screen>
  );
}
