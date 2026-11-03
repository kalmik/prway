import type { DiffscopeApi } from '../shared/types'

declare global {
  interface Window {
    diffscope: DiffscopeApi
  }
}

export {}
