import { Text } from 'react-native';
import { verificationEnabled, verificationRequest } from '../src/verification/access';
import { Stack, ThemeProvider, DefaultTheme, DarkTheme, usePathname, useGlobalSearchParams } from 'expo-router';
import { AppearanceProvider, useTheme } from '../src/ui/appearance';
import { I18nProvider } from '../src/i18n';

function Navigation() {
  const { c, scheme, reducedMotion } = useTheme();
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  return <ThemeProvider value={{ ...base, colors: { ...base.colors, primary: c.accent, background: c.background, card: c.surface, text: c.text, border: c.line, notification: c.danger } }}><Stack screenOptions={{ headerShown: false, animation: reducedMotion ? 'none' : 'slide_from_right', contentStyle: { backgroundColor: c.background } }} /></ThemeProvider>;
}
export default function Layout() {
  const path = usePathname(), params = useGlobalSearchParams();
  // Reject before AppearanceProvider opens the production workspace or mounts
  // a route. A verification URI never upgrades an ordinary release capability.
  const requested = verificationRequest(path, params.action);
  if (requested && !verificationEnabled()) return <Text testID="arxd-verification-disabled">Verification is disabled in this build</Text>;
  return <I18nProvider standalone={path.startsWith('/verify')}><AppearanceProvider standalone={path.startsWith('/verify')}><Navigation /></AppearanceProvider></I18nProvider>;
}
