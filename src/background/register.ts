import { AppRegistry } from 'react-native';
import { agentSessions, backgroundSession } from './android';

AppRegistry.registerHeadlessTask('ArxdAgentSession', () => async ({ generation }: { generation: string }) => {
  backgroundSession().ready(generation);
  while (true) {
    const state = backgroundSession().status();
    if (state.generation !== generation) return;
    if (state.stopping) { await agentSessions.stop(); return; }
    if (!state.active) return;
    // Headless JS owns these timers even when the Activity is paused. Do not
    // hold an Expo module coroutine open for the entire session lifetime.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
});
