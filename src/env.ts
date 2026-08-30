import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const DEFAULT_TEMP_TTL = 24 * 60 * 60 * 1000

export const env = createEnv({
  server: {
    STORAGE_ROOT: z.string().min(1).default('./storage'),
    BASE_URL: z.url({ protocol: /^https?$/ }),
    MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_MAX_UPLOAD_BYTES),
    TEMP_TTL: z.coerce.number().int().positive().default(DEFAULT_TEMP_TTL),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
})
