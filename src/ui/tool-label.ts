import { localeNow, translate } from '../i18n/index.ts';

export function toolLabel(name: string, details?: unknown) {
  const t = (text: string) => translate(localeNow(), text);
  const skill = details as { skillName?: string } | undefined;
  if (name === 'shell') return t('运行本地脚本');
  if (name.startsWith('rxd_')) return t('查询 JavaScript 结构');
  if (name === 'skill_search') return t('查找技能');
  if (name === 'skill_load') return skill?.skillName ? `${t('使用技能')} · ${skill.skillName}` : t('使用技能');
  if (name === 'skill_read') return skill?.skillName ? `${t('读取技能资源')} · ${skill.skillName}` : t('读取技能资源');
  return name;
}
