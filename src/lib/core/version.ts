/**
 * A program's version for the drivers that ask it separately (JDownloader, qBittorrent, NZBGet, pyLoad): read with the
 * first query and again after a failed one — the program may have restarted for an update. An empty answer is not
 * kept: the next query asks again.
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
      const version = this.value ?? (await read());
      this.value = version || null;
      return await query(version);
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
