import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Easing, Modal, StyleSheet } from 'react-native';
import { useTheme } from './appearance';
import { motion } from './theme';

/** Retain outgoing content until exit finishes; reopening cancels that exit. */
export function MotionModal<T>({ value, onClose, children, page = false }: { value: T | null; onClose: () => void; children: (value: T) => ReactNode; page?: boolean }) {
  const { reducedMotion } = useTheme();
  const [retained, setRetained] = useState(value);
  const [mounted, setMounted] = useState(value !== null);
  const [progress] = useState(() => new Animated.Value(0));
  if (value !== null && retained !== value) setRetained(value);
  if (value !== null && !mounted) setMounted(true);
  const shown = value !== null;
  useEffect(() => {
    const animation = Animated.timing(progress, { toValue: shown ? 1 : 0, duration: reducedMotion ? 0 : shown ? motion.enter : motion.exit, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    animation.start(({ finished }) => { if (finished && !shown) { setMounted(false); setRetained(null); } });
    return () => animation.stop();
  }, [shown, progress, reducedMotion]);
  return <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent><Animated.View pointerEvents={shown ? 'auto' : 'none'} accessibilityElementsHidden={!shown} importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'} style={[StyleSheet.absoluteFill, { opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [page ? 16 : 24, 0] }) }] }]}>{retained !== null && children(retained)}</Animated.View></Modal>;
}
