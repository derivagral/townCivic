import { useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import type { BrowseView, EventPage, EventSummary } from '@towncivic/api-contracts';
import { useApp, useResource } from '../lib/state';
import { Button, Message, SampleNotice, Screen, Select, colors, dateLabel, styles } from './ui';
import { EventReader } from './EventReader';

export function TownSelect() {
  const { catalog, town, setTown } = useApp();
  return (
    <Select
      label="Town"
      value={town}
      options={catalog.towns.map((t) => ({ value: t.id, label: t.label.replace(', Massachusetts', '') }))}
      onChange={setTown}
    />
  );
}
export function EventCard({
  item,
  selected,
  onPress,
}: {
  item: EventSummary;
  selected?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.title}, ${dateLabel(item.date)}`}
      onPress={onPress}
      style={[styles.card, selected && { borderColor: colors.accent, backgroundColor: colors.pale }]}
    >
      <Text style={styles.label}>
        {item.typeLabel.toUpperCase()} · {dateLabel(item.date)}
      </Text>
      <Text style={styles.heading}>{item.title}</Text>
      <Text style={styles.muted}>{item.body}</Text>
      {!!item.excerpt && (
        <Text style={styles.text} numberOfLines={4}>
          {item.matchingPassage ? 'Matching passage: ' : ''}
          {item.excerpt}
        </Text>
      )}
      <Text style={styles.muted}>{item.source} →</Text>
    </Pressable>
  );
}
export function Browse({ view: initialView }: { view: BrowseView }) {
  const { town } = useApp();
  return <BrowseTown key={`${town}:${initialView}`} initialView={initialView} town={town} />;
}
function BrowseTown({ initialView, town }: { initialView: BrowseView; town: string }) {
  const [view, setView] = useState(initialView);
  const [draft, setDraft] = useState('');
  const [q, setQuery] = useState('');
  const [body, setBody] = useState('');
  const [when, setWhen] = useState('all');
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<{ query: string; id: string } | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const { width } = useWindowDimensions();
  const wide = width >= 850;
  const query = new URLSearchParams({ town, view, q, body, when, page: String(page) });
  const { data, loading, error, retry } = useResource<EventPage>(`/events?${query}`);
  const selected = selection?.query === query.toString() ? selection.id : null;
  const search = () => {
    setQuery(draft.trim());
    setPage(1);
  };
  const open = (id: string) =>
    wide
      ? setSelection({ query: query.toString(), id })
      : router.push({ pathname: '/event/[id]', params: { id, q } });
  const header = (
    <View style={{ gap: 12, marginBottom: 18 }}>
      <Text style={[styles.title, { fontSize: 24 }]}>
        {initialView === 'activity' ? 'Around town' : 'Local discussions'}
      </Text>
      <TownSelect />
      <View style={styles.row}>
        <TextInput
          accessibilityLabel="Search meeting and record text"
          placeholder="Housing, school budgets, road safety…"
          placeholderTextColor={colors.muted}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={search}
          returnKeyType="search"
          maxLength={300}
          style={[styles.input, { flex: 1, minWidth: 180 }]}
        />
        <Button title="Search" onPress={search} />
      </View>
      <View style={styles.row}>
        {initialView !== 'activity' && (
          <>
            <Button
              title="Transcripts"
              selected={view === 'transcripts'}
              onPress={() => {
                setView('transcripts');
                setPage(1);
                setBody('');
              }}
            />
            <Button
              title="All meetings"
              selected={view === 'meetings'}
              onPress={() => {
                setView('meetings');
                setPage(1);
                setBody('');
              }}
            />
          </>
        )}
        <Button title={filtersOpen ? 'Hide filters' : 'Filters'} onPress={() => setFiltersOpen((v) => !v)} />
      </View>
      {filtersOpen && (
        <View style={{ gap: 8 }}>
          <Select
            label="Board"
            value={body}
            options={[
              { value: '', label: 'All boards' },
              ...(body && !data?.boards.some((b) => b.value === body) ? [{ value: body, label: body }] : []),
              ...(data?.boards ?? []).map((b) => ({ value: b.value, label: b.value })),
            ]}
            onChange={(v) => {
              setBody(v);
              setPage(1);
            }}
          />
          <Select
            label="When"
            value={when}
            options={[
              { value: 'all', label: 'Any time' },
              { value: 'past', label: 'Past' },
              { value: 'upcoming', label: 'Upcoming' },
            ]}
            onChange={(v) => {
              setWhen(v);
              setPage(1);
            }}
          />
        </View>
      )}
      <SampleNotice visible={data?.sampleData} />
      {data && (
        <Text style={styles.label}>
          {data.total.toLocaleString()} {view === 'transcripts' ? 'TRANSCRIPTS' : 'RECORDS'}
          {q ? ` MATCHING “${q}”` : ''}
        </Text>
      )}
    </View>
  );
  return (
    <Screen>
      <View style={{ flex: 1, flexDirection: 'row' }}>
        <View style={{ flex: wide ? undefined : 1, width: wide ? 390 : undefined }}>
          <FlatList
            data={data?.items ?? []}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.padded}
            keyboardShouldPersistTaps="handled"
            refreshing={loading}
            onRefresh={retry}
            ListHeaderComponent={header}
            renderItem={({ item }) => (
              <EventCard item={item} selected={selected === item.id} onPress={() => open(item.id)} />
            )}
            ListEmptyComponent={
              <Message
                title={loading ? 'Loading records…' : error ? 'Unable to load records' : 'No records found'}
                detail={
                  error ||
                  (view === 'transcripts'
                    ? 'Try another search, all meetings, or another town. Milton currently has the strongest transcript coverage.'
                    : 'Try another search or town.')
                }
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
        </View>
        {wide && (
          <View style={{ flex: 1, borderLeftWidth: 1, borderLeftColor: colors.line }}>
            {selected ? (
              <EventReader key={selected} id={selected} initialQuery={q} />
            ) : (
              <Message
                title="A closer look at your town"
                detail="Choose a meeting to read its transcript beside the results."
              />
            )}
          </View>
        )}
      </View>
    </Screen>
  );
}
