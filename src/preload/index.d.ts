import type { PrwayApi } from '../shared/types'

declare global {
  interface Window {
    prway: PrwayApi
  }
}

export {}
