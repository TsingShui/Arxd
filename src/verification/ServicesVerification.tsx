import { requireVerification } from './access';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { openServicesVerification, functionalServices, externalHttpServices, reopenServiceDeletion, startServicesCheckpoint, resumeServicesCheckpoint, backgroundServices, closeServicesVerification, storageFaultServices, type ServicesCase } from './services';
import { publishEvidence } from './evidence';

/** Actual durable Pi/native acceptance workspace; no user credentials or default conversation DB. */
export default function ServicesVerification() {
  const params = useLocalSearchParams<{ run?: string; case?: string; stage?: string; url?: string }>();
  const [status, setStatus] = useState('Offline deterministic Pi → actual Android processes/MCP');
  const started = useRef('');
  useEffect(() => {
    requireVerification();
    const run = params.run ?? 'manual', profile = (params.case ?? 'functional') as ServicesCase, stage = params.stage ?? 'run';
    const key = `${run}/${profile}/${stage}`;
    if (started.current === key) return; started.current = key;
    if (!['external-http', 'functional', 'background', 'intent', 'spawn', 'result', 'input', 'mcp', 'storage'].includes(profile)) { void Promise.resolve().then(() => setStatus('Invalid verification profile')); return; }
    void (async () => {
      const owner = await openServicesVerification(run, profile, stage === 'resume' || stage === 'finish' || stage === 'reopen', params.url);
      if (profile === 'external-http') await externalHttpServices(owner, stage, setStatus);
      else if (profile === 'functional') { if (stage === 'reopen') await reopenServiceDeletion(owner); else await functionalServices(owner, setStatus); }
      else if (profile === 'storage') await storageFaultServices(owner);
      else if (profile === 'background') await backgroundServices(owner, stage === 'finish');
      else if (stage === 'resume') await resumeServicesCheckpoint(owner);
      else await startServicesCheckpoint(owner);
      if (profile !== 'background' || stage === 'finish') await closeServicesVerification(owner);
      setStatus('Verified actual Android behavior; inspect evidence for scope and root capability.');
    })().catch((error: unknown) => {
      setStatus('Failed: ' + String(error));
      publishEvidence(JSON.stringify({ event: 'arxd-services-failed', run, profile, stage, error: String(error).slice(0, 2000) }));
    });
  }, [params.run, params.case, params.stage, params.url]);
  return <SafeAreaView style={{ flex: 1, backgroundColor: '#171614' }}><ScrollView contentContainerStyle={{ padding: 24 }}><Text accessibilityLabel="Services verification status" style={{ color: '#e8e1d7', fontSize: 16, lineHeight: 26 }}>{status}</Text></ScrollView></SafeAreaView>;
}
