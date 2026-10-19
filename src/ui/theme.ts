export const palettes = {
  fire: {
    background: '#171614', nav: '#12110f', surface: '#1e1c19', raised: '#24211d',
    text: '#e8e1d7', heading: '#f3ede3', quiet: '#b3aa9d', faint: '#a19689',
    accent: '#e76835', line: '#3a3630', accentLine: '#704630', wash: '#2b201a', code: '#141310',
    scrim: 'rgba(0,0,0,0.55)', danger: '#ef9a83', warning: '#dfb76c', thinking: '#c1a7ef', contextSmall: '#92baf1', contextMedium: '#70c9bd', contextLarge: '#ebc078', onAccent: '#171614',
    syntax: { keyword: '#e76835', string: '#9ac97e', number: '#dfb76c', comment: '#7f766a', title: '#92baf1', builtin: '#c1a7ef', meta: '#70c9bd', attr: '#ebc078', literal: '#dfb76c', variable: '#e8e1d7' },
  },
  spring: {
    background: '#f3f5ec', nav: '#e9ede1', surface: '#f9faf5', raised: '#ffffff',
    text: '#2b3730', heading: '#1f2c25', quiet: '#5f6c61', faint: '#5c6959',
    accent: '#426632', line: '#d2dacd', accentLine: '#a1b69a', wash: '#e7eddd', code: '#ecf0e5',
    scrim: 'rgba(24,34,24,0.3)', danger: '#a43b2c', warning: '#8c6319', thinking: '#785390', contextSmall: '#305f9b', contextMedium: '#286f65', contextLarge: '#805709', onAccent: '#ffffff',
    syntax: { keyword: '#426632', string: '#3f6b35', number: '#8c6319', comment: '#5c6959', title: '#305f9b', builtin: '#785390', meta: '#286f65', attr: '#805709', literal: '#8c6319', variable: '#2b3730' },
  },
};
export type Colors = typeof palettes.fire;
export type ColorScheme = 'light' | 'dark';
const fireLight: Colors = {
  background: '#fbf7f1', nav: '#f2ebe1', surface: '#ffffff', raised: '#fffdfa', text: '#39312a', heading: '#241d17', quiet: '#706256', faint: '#736354',
  accent: '#ae461b', line: '#ded3c5', accentLine: '#c9987d', wash: '#f6e7dc', code: '#f3ede5', scrim: 'rgba(36,29,23,0.3)', danger: '#a43b2c', warning: '#8c6319', thinking: '#785390', contextSmall: '#305f9b', contextMedium: '#286f65', contextLarge: '#805709', onAccent: '#ffffff',
  syntax: { keyword: '#ae461b', string: '#3e6b2f', number: '#8c6319', comment: '#736354', title: '#305f9b', builtin: '#785390', meta: '#286f65', attr: '#805709', literal: '#8c6319', variable: '#39312a' },
};
const springDark: Colors = {
  background: '#151c18', nav: '#101712', surface: '#1d2820', raised: '#26332a', text: '#e0e9df', heading: '#f0f5eb', quiet: '#adbcac', faint: '#a0b09f',
  accent: '#a0c583', line: '#34483a', accentLine: '#66805b', wash: '#283b27', code: '#111912', scrim: 'rgba(0,0,0,0.55)', danger: '#eea18d', warning: '#dfb76c', thinking: '#c1a7ef', contextSmall: '#92baf1', contextMedium: '#70c9bd', contextLarge: '#ebc078', onAccent: '#151c18',
  syntax: { keyword: '#a0c583', string: '#9ac97e', number: '#dfb76c', comment: '#7d8f7c', title: '#92baf1', builtin: '#c1a7ef', meta: '#70c9bd', attr: '#ebc078', literal: '#dfb76c', variable: '#e0e9df' },
};
export function colorsFor(palette: 'fire' | 'spring', scheme: ColorScheme): Colors { return palette === 'fire' ? scheme === 'dark' ? palettes.fire : fireLight : scheme === 'light' ? palettes.spring : springDark; }
export const layout = { page: 20, gap: 12, header: 64, control: 44, radius: 14, card: 18 };
export const motion = { enter: 180, exit: 130, content: 180, focus: 180 };

/** Mix a hex colour towards white (positive amount) or black (negative). */
export function shade(hex: string, amount: number): string {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((part) => part + part).join('') : raw;
  const value = parseInt(full, 16);
  const mix = (channel: number) => Math.round(amount >= 0 ? channel + (255 - channel) * amount : channel * (1 + amount));
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(mix);
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

