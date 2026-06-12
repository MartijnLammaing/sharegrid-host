import { isIP } from 'node:net';

import { z } from 'zod';

import { parseFingerprintFromUrl, type NetworkMode } from '@sharegrid/shared/tls';

const fpPattern = /[?&]fp=sha256:[0-9a-f]{64}(&|$)/;
const keyPattern = /[?&]key=[A-Za-z0-9_-]+(&|$)/;

/**
 * Derive the router's network mode from a router URL without throwing. Used
 * during config validation, where {@link parseFingerprintFromUrl} may reject a
 * malformed URL that other refinements already report on.
 */
function modeFromUrl(url: string): NetworkMode {
  try {
    return parseFingerprintFromUrl(url).mode;
  } catch {
    return 'lan';
  }
}

const ConfigSchema = z
  .object({
    SHAREGRID_ROUTER_URL: z
      .string()
      .url('must be a valid URL')
      .refine((val) => fpPattern.test(val), {
        message: 'must contain fp=sha256:<64 hex chars> query param',
      })
      .refine((val) => keyPattern.test(val), {
        message: 'must contain key=<base64url> query param (host registration secret from router)',
      }),
    SHAREGRID_LISTEN_PORT: z.coerce
      .number()
      .int()
      .min(1, 'must be >= 1')
      .max(65535, 'must be <= 65535'),
    SHAREGRID_HEARTBEAT_INTERVAL: z.coerce.number().int().positive().default(30),
    SHAREGRID_MODELS_DIR: z.string().min(1, 'must not be empty'),
    SHAREGRID_LISTEN_HOST: z.string().min(1, 'must not be empty'),
  })
  .superRefine((cfg, ctx) => {
    // The advertised address family must match the router's network mode:
    // IPv4 in `lan` mode, IPv6 in `internet` mode.
    const mode = modeFromUrl(cfg.SHAREGRID_ROUTER_URL);
    const family = isIP(cfg.SHAREGRID_LISTEN_HOST); // 0 (invalid), 4, or 6
    const expected = mode === 'internet' ? 6 : 4;
    if (family !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SHAREGRID_LISTEN_HOST'],
        message:
          mode === 'internet'
            ? 'router is in internet mode — must be the host machine global IPv6 address that users connect to (e.g. 2001:db8::1); set by docker-run.sh'
            : 'must be the host machine LAN IPv4 address that users connect to (e.g. 192.168.1.42); set by docker-run.sh',
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema> & {
  /** Router network mode, parsed from SHAREGRID_ROUTER_URL. */
  mode: NetworkMode;
};

export function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Configuration error:', JSON.stringify(result.error.flatten().fieldErrors, null, 2));
    process.exit(1);
  }
  return { ...result.data, mode: modeFromUrl(result.data.SHAREGRID_ROUTER_URL) };
}
