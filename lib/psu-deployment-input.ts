import { execFileSync } from 'node:child_process';
import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EnvironmentConfig } from '../config/environment';
interface Input {
  worker: {
    configuration: {
      region: string;
      account: string;
      secretArn: string;
      release: { serviceArn: string; taskDefinitionFamily: string; imageDigest: string };
    };
    qualification: unknown;
  };
  api?: { release: unknown; qualification: unknown };
}
export interface PsuDeploymentInput {
  workerEnvironment: Record<string, string>;
  apiEnvironment: Record<string, string>;
  providerSecretArn: string;
  imageDigest: string;
}
/** Explicit reviewed file; canonical Runtime validators run offline on the exact bytes consumed. */
export function loadPsuDeploymentInput(
  path: unknown,
  mode: 'worker' | 'api',
  config: EnvironmentConfig,
): PsuDeploymentInput | undefined {
  if (path === undefined) return undefined;
  try {
    if (typeof path !== 'string' || config.name !== 'dev') throw new Error();
    const fd = openSync(path, 'r');
    let bytes: Buffer;
    try {
      if (!fstatSync(fd).isFile()) throw new Error();
      const buffer = Buffer.alloc(32769);
      let used = 0;
      while (used < buffer.length) {
        const n = readSync(fd, buffer, used, buffer.length - used, null);
        if (!n) break;
        used += n;
      }
      if (used > 32768) throw new Error();
      bytes = buffer.subarray(0, used);
    } finally {
      closeSync(fd);
    }
    execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(__dirname, '../../vamberic-agent-runtime/scripts/verify-psu-deployment-input.ts'),
        mode,
      ],
      { input: bytes, timeout: 10000, maxBuffer: 4096, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Input;
    const c = p.worker.configuration;
    if (
      c.account !== config.account ||
      c.region !== config.region ||
      c.release.taskDefinitionFamily !== `vamberic-${config.name}-agent-runtime` ||
      c.release.serviceArn !==
        `arn:aws:ecs:${config.region}:${config.account}:service/vamberic-${config.name}-api/vamberic-${config.name}-agent-runtime`
    )
      throw new Error();
    return {
      workerEnvironment: {
        PSU_PRODUCTION_CONFIG: JSON.stringify(c),
        PSU_TERMINAL_QUALIFICATION: JSON.stringify(p.worker.qualification),
      },
      apiEnvironment:
        mode === 'api'
          ? {
              PSU_PRODUCTION_RELEASE: JSON.stringify(p.api!.release),
              PSU_TERMINAL_QUALIFICATION: JSON.stringify(p.api!.qualification),
            }
          : {},
      providerSecretArn: c.secretArn,
      imageDigest: c.release.imageDigest,
    };
  } catch {
    throw new Error('Invalid PSU deployment input; no configuration synthesized.');
  }
}
