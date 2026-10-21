import Svg, { Circle, Path, Rect } from 'react-native-svg';

export type IconName = 'menu' | 'plus' | 'chat' | 'search' | 'chevron' | 'arrow' | 'right' | 'back' | 'close' | 'check' | 'file' | 'code' | 'folder' | 'sun' | 'moon' | 'settings' | 'share' | 'copy' | 'spark' | 'brain' | 'sliders' | 'openai' | 'kimi' | 'xai' | 'claude' | 'github' | 'router' | 'meta' | 'stop' | 'edit' | 'terminal' | 'filter' | 'grid' | 'user' | 'more' | 'trash' | 'refresh' | 'compose' | 'archive' | 'download' | 'upload' | 'report' | 'save' | 'compress' | 'power' | 'plug' | 'move' | 'new-file' | 'store' | 'import';
const paths: Partial<Record<IconName, string>> = {
  menu: 'M4 6h16M4 12h12M4 18h16', plus: 'M12 4v16M4 12h16',
  chat: 'M20 11.5a8.2 8.2 0 0 1-8.5 8L4 21l1.4-6A8 8 0 1 1 20 11.5Z',
  chevron: 'm6 9 6 6 6-6', back: 'M19 12H5m6-6-6 6 6 6', arrow: 'M12 19V5m-6 6 6-6 6 6', right: 'M4 12h16m-6-6 6 6-6 6', close: 'm6 6 12 12M6 18 18 6', check: 'm5 12 4.5 4.5L19 7',
  file: 'M14 3H5v18h14V8l-5-5ZM14 3v6h5M8 13h8M8 17h5', code: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 20',
  folder: 'M3 6h7l2 3h9v11H3V6ZM3 6V4h7l2 2h7v3',
  moon: 'M20 15a8.7 8.7 0 0 1-11-11 8.8 8.8 0 1 0 11 11Z',
  settings: 'm10 3-.8 2.4-2 .9L4.8 6 3 9l1.5 1.8v2.4L3 15l1.8 3 2.4-.3 2 .9L10 21h4l.8-2.4 2-.9 2.4.3 1.8-3-1.5-1.8v-2.4L21 9l-1.8-3-2.4.3-2-.9L14 3h-4Z',
  share: 'M12 16V3m-4 4 4-4 4 4M5 12v9h14v-9', copy: 'M15 8V3H3v13h5',
  spark: 'm12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z',
  brain: 'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18ZM12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18ZM15 13a4.5 4.5 0 0 1-2.5 4M17.599 6.5a3 3 0 0 0 .399-1.375M6.003 5.125A3 3 0 0 0 6.401 6.5M3.477 10.896a4 4 0 0 1 .585-.396M19.938 10.5a4 4 0 0 1 .585.396M6 18a4 4 0 0 1-1.967-.516M19.967 17.484A4 4 0 0 1 18 18',
  edit: 'm15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  openai: 'm12 3 7 4v9l-7 4-7-4V7l7-4Zm0 4-3.5 2v6L12 17l3.5-2V9L12 7Z',
  kimi: 'M6 4v16M6 12l11-8M9 12l9 8',
  xai: 'M5 4l14 16M19 4 5 20',
  claude: 'M12 3v18M4 7l16 10M20 7 4 17',
  github: 'M9 19c-4 1.5-4-2-5-2m10 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.7 4.7 0 0 0-1.3-3.2 4.4 4.4 0 0 0-.1-3.3s-1-.3-3.4 1.3a11.7 11.7 0 0 0-6 0C5.8 3.6 4.8 3.9 4.8 3.9a4.4 4.4 0 0 0-.1 3.3A4.7 4.7 0 0 0 3.4 10c0 4.6 2.7 5.7 5.5 6-.4.4-.6 1-.5 2V21',
  router: 'M4 7h16M4 12h10M4 17h7m8-7 3 2-3 2',
  meta: 'M7 12c0-3 2-5 4-5s4 2 4 5-2 5-4 5-4-2-4-5Zm10 0c0-3 2-5 4-5M3 12c0-3 1-5 3-5',
  terminal: 'M4 6h16v12H4V6Zm3 4 2.5 2.5L7 15m5 0h4',
  filter: 'M4 5h16l-6 7v7l-4-2v-5L4 5Z',
  grid: 'M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0',
  more: 'M6 12h0M12 12h0M18 12h0',
  trash: 'M4 7h16M9 7V4h6v3m-8 0 .9 13h8.2L17 7',
  refresh: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5',
  compose: 'M12 4H5v15h15v-7M18 3l3 3-9 9-4 1 1-4 9-9Z',
  archive: 'M3 6h18M5 6v14h14V6M9 3h6v3M12 10v5m-2-2 2 2 2-2',
  download: 'M12 3v12m-4-4 4 4 4-4M4 21h16',
  upload: 'M12 21V9m-4 4 4-4 4 4M4 3h16',
  report: 'M6 3h9l4 4v14H6V3Zm9 0v5h4M9 17v-3m3 3v-6m3 6v-4',
  save: 'M5 3h11l3 3v15H5V3Zm3 0v6h8V3M8 21v-7h8v7',
  compress: 'M4 12h6m-3-3 3 3-3 3M20 12h-6m3-3-3 3 3 3',
  power: 'M12 3v9m5.7-6.7a9 9 0 1 1-11.4 0',
  plug: 'M9 3v5m6-5v5M7 8h10v3a5 5 0 0 1-10 0V8Zm3 11v3m4-3v3',
  move: 'M3 6h7l2 3h9v11H3V6Zm9 8h6m-2-2 2 2-2 2',
  store: 'M4 9h16l-1.2-5H5.2L4 9Zm1 0v11h14V9M3 9a2.5 2.5 0 0 0 4.5 1.5A2.5 2.5 0 0 0 12 10a2.5 2.5 0 0 0 4.5.5A2.5 2.5 0 0 0 21 9M9 20v-5h6v5',
  import: 'M12 3v10m-4-4 4 4 4-4M4 15v6h16v-6',
  'new-file': 'M14 3H5v18h14V8l-5-5Zm0 0v6h5M12 12v6m-3-3h6',
};
export function Icon({ name, color, size = 21 }: { name: IconName; color: string; size?: number }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.65} strokeLinecap="round" strokeLinejoin="round" accessible={false}>
    {paths[name] && <Path d={paths[name]} />}
    {name === 'search' && <><Circle cx={10.5} cy={10.5} r={6.5} /><Path d="m16 16 4.5 4.5" /></>}
    {name === 'sun' && <><Circle cx={12} cy={12} r={4} /><Path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>}
    {name === 'settings' && <Circle cx={12} cy={12} r={3} />}
    {name === 'copy' && <Rect x={8} y={8} width={12} height={13} rx={2} />}
    {name === 'stop' && <Rect x={6} y={6} width={12} height={12} rx={1.5} fill={color} strokeWidth={0} />}
  </Svg>;
}
