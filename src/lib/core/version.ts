/**
 * A program's version for the drivers that ask it separately (JDownloader, qBittorrent, NZBGet, pyLoad): read with the
 * first query and again after a failed one — the program may have restarted for an update.
 */
export class ProgramVersion {
  private value: string | null = null;

  /**
   * @param read asks the program for its version
   * @param query the rest of one query
   * @returns what the query returns
   */
  public async poll<T>(read: () => Promise<string>, query: (version: string) => Promise<T>): Promise<T> {
    try {
      this.value ??= await read();
      return await query(this.value);
    } catch (err: unknown) {
      this.value = null;
      throw err;
    }
  }

  /** The next query reads the version again. */
  public forget(): void {
    this.value = null;
  }
}
