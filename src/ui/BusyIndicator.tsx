import { ActivityIndicator, View, type ActivityIndicatorProps } from 'react-native';
import { useTheme } from './appearance';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

/** Keep busy state visible without a spinning loop when motion is reduced. */
export function BusyIndicator(props: ActivityIndicatorProps) {
  const { reducedMotion, c } = useTheme(); const { t } = useI18n();
  if (!reducedMotion) return <ActivityIndicator {...props} />;
  const size = typeof props.size === 'number' ? props.size : props.size === 'large' ? 36 : 20;
  return <View accessibilityRole="progressbar" accessibilityLabel={props.accessibilityLabel ?? t('处理中')} accessibilityState={{ busy: true }} style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, props.style]}><Icon name="more" size={size} color={typeof props.color === 'string' ? props.color : c.accent} /></View>;
}
