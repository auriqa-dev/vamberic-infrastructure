/** PSU is configured on the application, independently of Agent deployment. */
export function psuAppInput(value: unknown, account: string | undefined, region: string) {
  if (value === undefined) return undefined;
  if (!account) throw new Error('PSU app requires an explicit AWS account');
  if (typeof value === 'string') value = JSON.parse(value);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid PSU app configuration');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(',') !== 'model,projectId,secretArn' ||
    typeof v.secretArn !== 'string' ||
    typeof v.projectId !== 'string' ||
    typeof v.model !== 'string' ||
    !v.secretArn.startsWith(`arn:aws:secretsmanager:${region}:${account}:secret:vamberic/`) ||
    !/^proj_[A-Za-z0-9_-]+$/.test(v.projectId) ||
    !/^[a-zA-Z0-9._-]+$/.test(v.model)
  )
    throw new Error('Invalid PSU app configuration');
  return { secretArn: v.secretArn, projectId: v.projectId, model: v.model };
}
