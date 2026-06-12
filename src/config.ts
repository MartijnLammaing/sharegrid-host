import { z } from 'zod';

const fpPattern = /[?&]fp=sha256:[0-9a-f]{64}(&|$)/;
const keyPattern = /[?&]key=[A-Za-z0-9_-]+(&|$)/;

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
  SHAREGRID_MODELS_DIR: z.string().default('/data/models'),
  SHAREGRID_LISTEN_HOST: z.string().default(''),
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
