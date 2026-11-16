import "@/components/brand/blog-reading.css"
import styles from "./blog-reading-specimen.module.css"

export function BlogReadingSpecimen() {
  return (
    <div className={`blog-shell ${styles.surface}`}>
      <div className="blog-prose">
        <p>
          Blog articles share this reading surface. Links stay <a href="#blog-reading-section">underlined in brand blue</a>, and
          commands such as <code>alook inbox pull</code> sit in a recessed well.
        </p>
        <h2 id="blog-reading-section"><a href="#blog-reading-section">A section heading</a></h2>
        <p>Each top-level section opens with a # keycap that links to the section.</p>
        <ul>
          <li>Unordered items use brand-blue indicator squares.</li>
          <li>They mark independent points.</li>
        </ul>
        <ol>
          <li>Ordered numbers use mono figures.</li>
          <li>They stay quieter than the text.</li>
        </ol>
        <blockquote>
          <p><strong>Planning agent:</strong> The session moved to Friday at 3 p.m. I attached the updated brief.</p>
        </blockquote>
        <pre><code>{"pnpm dlx @alook/app connect --key ••••"}</code></pre>
        <table>
          <thead><tr><th>Element</th><th>Treatment</th></tr></thead>
          <tbody>
            <tr><td>Table</td><td>One hairline case with a header seam</td></tr>
            <tr><td>Break</td><td>A dashed tear line</td></tr>
          </tbody>
        </table>
        <hr />
        <section data-footnotes>
          <h2>Footnotes</h2>
          <ol><li>Sources use a smaller italic level.</li></ol>
        </section>
      </div>
    </div>
  )
}
