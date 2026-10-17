import { useLocalSearchParams } from 'expo-router';
import { EventReader } from '../../components/EventReader';
export default function EventScreen() {
  const { id, q } = useLocalSearchParams<{ id: string; q?: string }>();
  return <EventReader key={id} id={id} initialQuery={q} />;
}
