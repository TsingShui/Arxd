/** Verification is a deliberate isolated build capability, never a release default. */
module.exports = ({ config }) => {
  const applicationId = process.env.ARXD_ANDROID_APPLICATION_ID;
  const flag = process.env.ARXD_ENABLE_VERIFICATION;
  if (flag !== undefined && !['0', '1'].includes(flag)) throw new Error('ARXD_ENABLE_VERIFICATION must be 0 or 1');
  if (applicationId && !/^art\.tsingshui\.arxd\.[a-z][a-z0-9_]*$/.test(applicationId)) throw new Error('Invalid isolated Arxd application ID');
  const enabled = flag === '1';
  if (enabled && !applicationId) throw new Error('Verification requires an explicit isolated ARXD_ANDROID_APPLICATION_ID');
  // A side-by-side build needs its own label; the production name is never reused.
  const label = process.env.ARXD_ANDROID_APP_NAME;
  if (label !== undefined && (!/^[A-Za-z0-9 ._-]{1,40}$/.test(label) || !applicationId)) throw new Error('ARXD_ANDROID_APP_NAME must be a short label for an isolated application ID');
  return { ...config, ...(applicationId ? { name: label ?? 'Arxd Specs', android: { ...config.android, package: applicationId } } : {}),
    extra: { ...config.extra, arxdVerificationEnabled: enabled } };
};
