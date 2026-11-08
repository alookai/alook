import { StringDecoder } from "node:string_decoder";

export class Utf8TextDecoder {
  private decoder = new StringDecoder("utf8");
  write(chunk: Uint8Array | string): string {
    return this.decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  end(): string { return this.decoder.end(); }
  clear(): void { this.decoder = new StringDecoder("utf8"); }
}

export class Utf8LineFramer {
  private readonly decoder = new Utf8TextDecoder();
  private fragments: string[] = [];
  private bufferedBytes = 0;
  constructor(private readonly maxBufferedBytes?: number) {}
  get pendingByteLength(): number { return this.bufferedBytes; }
  write(chunk: Uint8Array | string): string[] {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (this.maxBufferedBytes !== undefined && this.bufferedBytes + bytes.byteLength > this.maxBufferedBytes) {
      this.clear();
      throw new Error("UTF-8 line buffer exceeded its byte limit");
    }
    const text = this.decoder.write(bytes);
    const lastDelimiter = bytes.lastIndexOf(0x0a);
    this.bufferedBytes = lastDelimiter === -1 ? this.bufferedBytes + bytes.byteLength : bytes.byteLength - lastDelimiter - 1;
    const lines: string[] = [];
    let offset = 0;
    for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", offset)) {
      this.fragments.push(text.slice(offset, newline));
      lines.push(this.fragments.join(""));
      this.fragments = [];
      offset = newline + 1;
    }
    if (offset < text.length) {
      const tail = text.slice(offset);
      this.fragments.push(tail);
    }
    return lines;
  }
  clear(): void { this.fragments = []; this.bufferedBytes = 0; this.decoder.clear(); }
}
