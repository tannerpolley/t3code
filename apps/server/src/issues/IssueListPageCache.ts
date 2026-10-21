/** Decoded REST pages; the owning repository's idle lifetime is managed by IssueService. */
export class IssueListPageCache<A> {
  private readonly pages = new Map<string, { readonly etag: string; readonly page: A }>();

  get(path: string) {
    return this.pages.get(path);
  }

  set(path: string, etag: string | undefined, page: A) {
    this.pages.delete(path);
    if (etag === undefined) return;
    this.pages.set(path, { etag, page });
    if (this.pages.size > 32) this.pages.delete(this.pages.keys().next().value!);
  }
}
