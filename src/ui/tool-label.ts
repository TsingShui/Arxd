import { localeNow, translate } from '../i18n/index.ts';

export function toolLabel(name: string, details?: unknown) {
  const t = (text: string) => translate(localeNow(), text);
  const skill = details as { skillName?: string } | undefined;
  if (name === 'shell') return t('Run local script');
  if (name.startsWith('rxd_')) return t('Query JavaScript structure');
  if (name === 'skill_search') return t('Find skills');
  if (name === 'skill_load') return skill?.skillName ? `${t('Use skill')} · ${skill.skillName}` : t('Use skill');
  if (name === 'skill_read') return skill?.skillName ? `${t('Read skill resource')} · ${skill.skillName}` : t('Read skill resource');
  return name;
}
