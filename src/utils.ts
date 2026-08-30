export const tryTo = async <T>(promise: Promise<T>) => {
  try {
    return [await promise, null] as const
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return [null, error] as const
  }
}
