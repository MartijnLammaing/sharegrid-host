import { z } from 'zod';

const fpPattern = /[?&]fp=sha256:[0-9a-f]{64}(&|$)/;
const keyPattern = /[?&]key=[A-Za-z0-9_-]+(&|$)/;
const ipv4Pattern = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

const ConfigSchema = z.object({
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
  SHAREGRID_MODEL_FILE: z.string().min(1, 'must not be empty'),
  SHAREGRID_MODEL_PATH: z.string().min(1, 'must not be empty'),
  SHAREGRID_LISTEN_HOST: z
    .string()
    .refine((val) => ipv4Pattern.test(val), {
      message:
        'must be the host machine LAN IPv4 address that users connect to (e.g. 192.168.1.42); set by docker-run.sh',
    }),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Configuration error:', JSON.stringify(result.error.flatten().fieldErrors, null, 2));
    process.exit(1);
  }
  return result.data;
}
