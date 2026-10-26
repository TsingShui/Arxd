import type { ProcessRecord, ServiceHost } from '../workspace/service-types.ts';
import type { TermuxResult } from '../../modules/rxd/index.ts';

export const ADB_SERVER = {
  name: 'ADB · Termux', identity: 'app' as const, origin: 'arxd-adb-cli',
  script: 'exec adb -L "$ADB_SERVER_SOCKET" nodaemon server',
};
export const ADB_INSTALL = 'set -eu\ncommand -v adb >/dev/null && { adb version; exit; }\napt-get -o APT::Update::Error-Mode=any update\napt-get --fix-broken --no-remove install -y\napt-get --no-remove install -y android-tools\nadb version\n';
export const adbTarget = (port: number) => {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port');
  return '127.0.0.1:' + port;
};
export function pairingScript(port: number) {
  return 'exec timeout -k 2 30 adb pair ' + adbTarget(port);
}
export function connectionScript(port: number) {
  const target = adbTarget(port);
  return `set -eu
adb connect ${target}
uid="$(adb -s ${target} shell id -u)"
[ "$uid" = 2000 ] || { printf '%s\\n' 'ADB is not a verified shell UID' >&2; exit 1; }
umask 077
printf '%s\\n' '${target}' > "$HOME/.arxd-adb-target.$$"
mv "$HOME/.arxd-adb-target.$$" "$HOME/.arxd-adb-target"
printf '%s\\n' "UID $uid · ${target}"
`;
}

/** Uses original android-tools, never a simulated adb command or shell whitelist. */
export class TermuxAdb {
  private services: ServiceHost;
  private identity: () => string;
  private run: (script: string, timeout: number) => Promise<TermuxResult>;
  constructor(services: ServiceHost, identity: () => string,
    run: (script: string, timeout: number) => Promise<TermuxResult>) {
    this.services = services; this.identity = identity; this.run = run;
  }
  async servers() {
    const matches: ProcessRecord[] = [];
    let offset: number | null = 0;
    do {
      const page = await this.services.list(offset, 32);
      matches.push(...page.items.filter((item) => item.origin === ADB_SERVER.origin && (['queued', 'starting', 'running', 'stopping'].includes(item.state) || item.processMaySurvive === true)));
      offset = page.nextOffset;
    } while (offset !== null);
    return matches;
  }
  async start() {
    const existing = await this.servers();
    if (existing.some((item) => item.state === 'lost')) throw new Error('Previous ADB server ownership is unconfirmed. Stop it in Processes first.');
    if (existing.length) return existing[0];
    return this.services.start(this.identity(), ADB_SERVER);
  }
  async stop() { await Promise.all((await this.servers()).map((item) => this.services.stop(item.id))); }
  async pair(port: number, code: string, cancelled: () => boolean = () => false) {
    if (!/^[0-9]{6}$/.test(code)) throw new Error('invalid_code');
    const record = await this.services.start(this.identity(), { name: 'ADB pairing', identity: 'app', script: pairingScript(port), origin: 'arxd-adb-pair' });
    try {
      const deadline = Date.now() + 15000;
      while (true) {
        if (cancelled()) throw new Error('Cancelled');
        const current = await this.services.inspect(record.id);
        if (current.state === 'running') break;
        if (!['queued', 'starting'].includes(current.state) || Date.now() > deadline) throw new Error('ADB pairing could not start');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // Never put the pairing secret in a script, argv, retained configuration or log.
      await this.services.write(record.id, code + '\n', true);
      return record;
    } catch (error) { await this.services.stop(record.id); throw error; }
  }
  connect(port: number) { return this.run(connectionScript(port), 20000); }
}
