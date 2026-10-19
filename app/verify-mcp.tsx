import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { verifyNativeMcp } from '../src/verification/mcp-native';

/** Trusted native Android acceptance; deliberately separate from the production pages. */
export default function VerifyMcp() {
  const { background, tlsUrl } = useLocalSearchParams<{ background?: string; tlsUrl?: string }>();
  const [status, setStatus] = useState('Preparing native MCP acceptance…');
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void verifyNativeMcp(setStatus, background === '1', tlsUrl).catch((error: unknown) => setStatus(`Failed: ${String(error)}`));
  }, [background, tlsUrl]);
  return <SafeAreaView style={{ flex: 1, backgroundColor: '#151519' }}><ScrollView contentContainerStyle={{ padding: 24 }}><Text style={{ color: '#f5f3ed', fontSize: 16, lineHeight: 26 }}>{status}</Text></ScrollView></SafeAreaView>;
}
