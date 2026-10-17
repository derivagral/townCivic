import { useMemo, useState } from 'react';
import { Alert, FlatList, Share, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import type { EventDetail } from '@towncivic/api-contracts';
import { useResource } from '../lib/state';
import { Button, Message, SampleNotice, Screen, colors, dateLabel, openUrl, styles, timestamp } from './ui';

export function EventReader({ id, initialQuery = '' }: { id: string; initialQuery?: string }) {
  const { data, error, loading, retry } = useResource<EventDetail>(`/events/${encodeURIComponent(id)}`);
  // Search results may use FTS prefixes; literal filtering is an optional reader
  // control, not an automatic filter that could hide a matching transcript.
  const [query, setQuery] = useState('');
  const segments = useMemo(
    () =>
      (data?.transcript?.segments ?? []).filter(
        (s) => !query.trim() || s.text.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [data, query],
  );
  if (!data)
    return (
      <Message
        title={loading ? 'Opening record…' : 'Unable to open record'}
        detail={error}
        loading={loading}
        retry={retry}
      />
    );
  const header = (
    <View style={{ gap: 14, marginBottom: 20 }}>
      <SampleNotice visible={data.sampleData} />
      <Text style={styles.label}>
        {data.typeLabel.toUpperCase()} · {dateLabel(data.date)}
      </Text>
      <Text style={styles.title} selectable>
        {data.title}
      </Text>
      <Text style={styles.muted}>
        {data.body} · {data.source}
      </Text>
      <View style={styles.row}>
        <Button title="Open source" onPress={() => openUrl(data.url)} />
        <Button
          title="Share source"
          onPress={() => {
            void Share.share({ title: data.title, message: `${data.title}\n${data.url}` }).catch(() =>
              Alert.alert('Unable to share', 'Please try again.'),
            );
          }}
        />
        {!!data.documentUrl && <Button title="Document" onPress={() => openUrl(data.documentUrl!)} />}
      </View>
      {!!data.summary && (
        <Text style={styles.text} selectable>
          {data.summary}
        </Text>
      )}
      {data.matters.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={styles.heading}>Related timelines</Text>
          {data.matters.map((m) => (
            <Button
              key={m.id}
              title={`${m.label} →`}
              onPress={() => router.push({ pathname: '/matter/[id]', params: { id: m.id } })}
            />
          ))}
        </View>
      )}
      {data.transcript ? (
        <>
          <Text style={styles.heading}>Meeting transcript</Text>
          <Text style={styles.muted}>
            Publisher’s automatic captions. Wording and speaker labels may be inaccurate. Tap a timestamp to
            check the recording.
          </Text>
          {!!initialQuery && <Text style={styles.muted}>Opened from search: “{initialQuery}”</Text>}
          <TextInput
            accessibilityLabel="Find text within this transcript"
            placeholder="Find in transcript…"
            placeholderTextColor={colors.muted}
            value={query}
            onChangeText={setQuery}
            style={styles.input}
          />
          {!!query.trim() && (
            <Text style={styles.muted}>
              {segments.length} matching passages · clear the field to read the whole meeting
            </Text>
          )}
        </>
      ) : (
        <>
          <Text style={styles.heading}>Record text</Text>
          <Text selectable style={styles.text}>
            {data.text ?? 'No extracted text is available. Open the source document to read this record.'}
          </Text>
        </>
      )}
    </View>
  );
  return (
    <Screen>
      <FlatList
        data={segments}
        keyExtractor={(item, index) => `${item.startSeconds}:${index}`}
        contentContainerStyle={[styles.padded, { width: '100%', maxWidth: 900, alignSelf: 'center' }]}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        initialNumToRender={12}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.row}>
              <Button
                title={timestamp(item.startSeconds)}
                onPress={() => openUrl(`${data.transcript!.videoUrl}&t=${item.startSeconds}s`)}
              />
              <Text style={styles.muted}>{item.speakerLabel}</Text>
            </View>
            <Text selectable style={styles.text}>
              {item.text}
            </Text>
          </View>
        )}
        ListEmptyComponent={
          data.transcript && query ? <Text style={styles.muted}>No passages contain that text.</Text> : null
        }
      />
    </Screen>
  );
}
