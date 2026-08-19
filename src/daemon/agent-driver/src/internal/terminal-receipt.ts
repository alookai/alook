export class TerminalReceiptFence {
  private sequence = 0;
  private activeReceipt: string | null = null;
  private readonly receiptByFingerprint = new Map<string, string>();
  constructor(private readonly prefix: string) {}
  beginTurn(): string {
    this.activeReceipt = `${this.prefix}:${++this.sequence}`;
    return this.activeReceipt;
  }
  claimTerminal(fingerprint: string): string {
    const known = this.receiptByFingerprint.get(fingerprint);
    if (known) return known;
    const receipt = this.activeReceipt ?? this.beginTurn();
    this.receiptByFingerprint.set(fingerprint, receipt);
    if (this.receiptByFingerprint.size > 64)
      this.receiptByFingerprint.delete(this.receiptByFingerprint.keys().next().value!);
    return receipt;
  }
  isCurrent(receipt: string): boolean {
    return receipt === this.activeReceipt;
  }
}
