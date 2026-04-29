export interface BrowserPage {
  goto(url: string, options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeout?: number }): Promise<unknown>
  waitForSelector(selector: string, options?: { timeout?: number; state?: "attached" | "detached" | "visible" | "hidden" }): Promise<BrowserElementHandle | null>
  $(selector: string): Promise<BrowserElementHandle | null>
  evaluate<T = unknown>(expression: string | ((...args: unknown[]) => T)): Promise<T>
  screenshot?(options?: { path?: string }): Promise<Buffer>
  keyboard?: { press(key: string): Promise<void> }
  close(): Promise<void>
}

export interface BrowserElementHandle {
  click(options?: { clickCount?: number }): Promise<void>
  type(text: string, options?: { delay?: number }): Promise<void>
}
