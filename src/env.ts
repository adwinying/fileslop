import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const DEFAULT_TEMP_TTL = 24 * 60 * 60 * 1000
const accessIdpsSchema = z
  .string()
  .transform((value, context): unknown => {
    try {
      return JSON.parse(value)
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'ACCESS_IDPS must be valid JSON',
      })
      return z.NEVER
    }
  })
  .pipe(
    z.array(
      z.object({
        name: z.string().min(1),
        type: z.string().min(1),
        config: z.record(z.string(), z.unknown()),
      }),
    ),
  )

const server = {
  STORAGE_ROOT: z.string().min(1).default('./storage'),
  BASE_URL: z.url({ protocol: /^https?$/ }),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MAX_UPLOAD_BYTES),
  TEMP_TTL: z.coerce.number().int().positive().default(DEFAULT_TEMP_TTL),
  CLOUDFLARE_API_TOKEN: z.string().min(1).optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1).optional(),
  ACCESS_EMAILS: z.string().min(1).optional(),
  ACCESS_EMAIL_DOMAINS: z.string().min(1).optional(),
  ACCESS_SESSION_DURATION: z.string().min(1).default('24h'),
  ACCESS_IDPS: accessIdpsSchema.optional(),
}

export const createEnvironment = (
  runtimeEnv: Record<string, string | boolean | number | undefined>,
) =>
  createEnv({
    server,
    createFinalSchema: (shape) =>
      z.object(shape).superRefine((value, context) => {
        if (
          value.CLOUDFLARE_API_TOKEN &&
          !value.ACCESS_EMAILS &&
          !value.ACCESS_EMAIL_DOMAINS
        ) {
          context.addIssue({
            code: 'custom',
            message:
              'CLOUDFLARE_API_TOKEN requires ACCESS_EMAILS or ACCESS_EMAIL_DOMAINS',
            path: ['CLOUDFLARE_API_TOKEN'],
          })
        }
      }),
    runtimeEnv,
    emptyStringAsUndefined: true,
  })

export const env = createEnvironment(process.env)
