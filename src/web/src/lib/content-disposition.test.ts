import { describe, expect, it } from "vitest"
import { contentDisposition, encodeRfc5987 } from "./content-disposition"
describe("download response filenames", () => {
  it.each(["report.pdf", "small-报告.bin", "📎😀.txt", 'a"b\\c.txt', "a\r\nb.txt", "a'()*%;.txt", ""])("constructs a legal header preserving %j in filename*", name => {
    const header = contentDisposition("attachment", name)
    const response = new Response("exact bytes", { headers: { "Content-Disposition": header } })
    expect(response.status).toBe(200)
    expect(header).toMatch(/^[\x20-\x7e]+$/)
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1])).toBe(name)
    expect(header.split("; filename*=")[0]).not.toMatch(/[\r\n\\]/)
  })
  it("escapes extended attribute punctuation and keeps inline disposition", () => {
    expect(encodeRfc5987("'()*")).toBe("%27%28%29%2A")
    expect(contentDisposition("inline", "报告.pdf")).toBe('inline; filename="__.pdf"; filename*=UTF-8\'\'%E6%8A%A5%E5%91%8A.pdf')
  })
})
