import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { serviceUiStage } from '../src/verification/services-ui';
import { publishEvidence } from '../src/verification/evidence';
import { useTheme } from '../src/ui/appearance';
export default function VerifyServicesUi() {
  const params = useLocalSearchParams<{ run: string; stage: string; package: string; nonce: string }>();
  const last = useRef(''); const [status, setStatus] = useState('Actual production UI acceptance'); const { c } = useTheme();
  useEffect(() => {
    if (last.current === params.nonce) return; last.current = params.nonce;
    void serviceUiStage(params.run, params.stage, params.package, params.nonce).then(() => setStatus('Stage complete; inspect actual state evidence.')).catch((error: unknown) => { setStatus(String(error)); publishEvidence(JSON.stringify({ event: 'arxd-services-ui-stage', stage: params.stage, run: params.run, nonce: params.nonce, verified: false, error: String(error).slice(0, 1000) })); });
  }, [params.run, params.stage, params.package, params.nonce]);
  return <SafeAreaView style={{ flex: 1, backgroundColor: c.background }}><ScrollView contentContainerStyle={{ padding: 24 }}><Text style={{ color: c.text }}>{status}</Text></ScrollView></SafeAreaView>;
}
