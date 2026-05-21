import type { TabItem } from '@/components/FloatingTabBar';

/**
 * The four primary tabs shown in the floating bottom bar across every
 * top-level screen. Per the spec we keep this list tight — three to four
 * items is the sweet spot for mobile navigation.
 */
export const PRIMARY_TABS: TabItem[] = [
  { href: '/', label: 'Today', icon: 'sunny-outline' },
  { href: '/plans', label: 'Plans', icon: 'list-outline' },
  { href: '/places', label: 'Places', icon: 'location-outline' },
  { href: '/settings', label: 'Settings', icon: 'settings-outline' },
];
