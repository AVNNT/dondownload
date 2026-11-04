import type { DonDownloadApi } from '@shared/types'

declare global {
  interface Window {
    donDownload: DonDownloadApi
  }
}

export {}
