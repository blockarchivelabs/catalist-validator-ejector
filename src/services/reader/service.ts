import { readFile, readdir } from 'fs/promises'

export type ReaderService = ReturnType<typeof makeReader>

export const makeReader = () => ({
  async dir(path: string) {
    return readdir(path)
  },
  async file(path: string) {
    return readFile(path)
  },
})