import { requireVerification } from '../src/verification/access';
import { useEffect, useRef, useState } from 'react';
import { Text, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getAndroidWorkspace } from '../src/workspace/android';
import { verifyServiceSafety } from '../src/verification/service-safety';

export default function VerifyServiceSafety() {
  const started = useRef(false), [status, setStatus] = useState('Preparing Android service safety acceptance…');
  useEffect(() => {
    requireVerification();
    if (started.current) return; started.current = true;
    void getAndroidWorkspace().then((core) => verifyServiceSafety(core, setStatus)).catch((error) => setStatus(String(error)));
  }, []);
  return <SafeAreaView style={{ flex: 1 }}><ScrollView contentContainerStyle={{ padding: 24 }}><Text>{status}</Text></ScrollView></SafeAreaView>;
}
