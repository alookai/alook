import { expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
import { BotPiiPlayground } from "./bot-pii-playground"

it("runs only nonempty input and displays returned text as text", () => {
  const onRun = vi.fn(), onValueChange = vi.fn()
  const view = render(<BotPiiPlayground value="" onValueChange={onValueChange} onRun={onRun} pending={false} />)
  expect(screen.getByRole("button", { name: "Run pipeline" })).toBeDisabled()
  fireEvent.change(screen.getByLabelText("Try a message"), { target: { value: "private sample" } })
  expect(onValueChange).toHaveBeenCalledWith("private sample")
  view.rerender(<BotPiiPlayground value="private sample" onValueChange={onValueChange} onRun={onRun} pending={false} result="<script>sample</script>" />)
  fireEvent.click(screen.getByRole("button", { name: "Run pipeline" }))
  expect(onRun).toHaveBeenCalledOnce()
  expect(screen.getByText("<script>sample</script>")).toBeVisible()
  expect(screen.getAllByRole("textbox")).toHaveLength(1)
  expect(view.container.querySelector("output")).toHaveTextContent("<script>sample</script>")
  expect(view.container.querySelector("script")).toBeNull()
  view.rerender(<BotPiiPlayground value="private sample" onValueChange={onValueChange} onRun={onRun} pending />)
  expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled()
})

it("explains the test transport and blocks input beyond the UTF-8 byte limit", () => {
  const onRun = vi.fn()
  render(<BotPiiPlayground value={"汉".repeat(342)} onValueChange={vi.fn()} onRun={onRun} pending={false} />)
  expect(screen.getByText("We don’t store this message. It is sent to your computer for testing.")).toBeVisible()
  expect(screen.getByRole("alert")).toHaveTextContent("1,024 UTF-8 bytes")
  expect(screen.getByRole("button", { name: "Run pipeline" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Run pipeline" }))
  expect(onRun).not.toHaveBeenCalled()
})
