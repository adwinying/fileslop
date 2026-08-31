type TryToResult<T> = readonly [T, null] | readonly [null, Error]

export function tryTo<T>(operation: () => T): TryToResult<T>
export function tryTo<T>(operation: Promise<T>): Promise<TryToResult<T>>
export function tryTo<T>(operation: Promise<T> | (() => T)) {
  if (typeof operation === 'function') {
    try {
      return [operation(), null] as const
    } catch (error) {
      if (!(error instanceof Error)) throw error
      return [null, error] as const
    }
  }

  return operation.then(
    (value) => [value, null] as const,
    (error: unknown) => {
      if (!(error instanceof Error)) throw error
      return [null, error] as const
    },
  )
}
