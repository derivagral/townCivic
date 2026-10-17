import { Tabs } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors } from '../../components/ui';
const icons = {
  index: 'chatbubbles-outline',
  activity: 'reader-outline',
  timelines: 'git-branch-outline',
  account: 'person-circle-outline',
} as const;
export default function TabLayout() {
  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerTitle: 'TownCivic',
        headerStyle: { backgroundColor: colors.paper },
        headerTintColor: colors.ink,
        tabBarActiveTintColor: colors.accent,
        tabBarStyle: { backgroundColor: colors.white },
        tabBarIcon: ({ color, size }) => (
          <Ionicons name={icons[route.name as keyof typeof icons]} color={color} size={size} />
        ),
      })}
    >
      <Tabs.Screen name="index" options={{ title: 'Meetings' }} />
      <Tabs.Screen name="activity" options={{ title: 'Activity' }} />
      <Tabs.Screen name="timelines" options={{ title: 'Timelines' }} />
      <Tabs.Screen name="account" options={{ title: 'Account' }} />
    </Tabs>
  );
}
