import { expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
import { BotPiiPlayground } from "./bot-pii-playground"

it("runs only nonempty input and displays returned text as text", () => {
  const onRun = vi.fn(), onValueChange = vi.fn()
  const view = render(<BotPiiPlayground value="" onValueChange={onValueChange} onRun={onRun} pending={false} />)
  expect(screen.getByRole("button", { name: "Run test" })).toBeDisabled()
  fireEvent.change(screen.getByLabelText("Original message"), { target: { value: "private sample" } })
  expect(onValueChange).toHaveBeenCalledWith("private sample")
  view.rerender(<BotPiiPlayground value="private sample" onValueChange={onValueChange} onRun={onRun} pending={false} result="<script>sample</script>" />)
  fireEvent.click(screen.getByRole("button", { name: "Run test" }))
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
  expect(screen.getByRole("button", { name: "Run test" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Run test" }))
  expect(onRun).not.toHaveBeenCalled()
})

it("links processing to the real pending state and reveals only returned output", () => {
  const props = { value: "sample@example.com", onValueChange: vi.fn(), onRun: vi.fn() }
  const view = render(<BotPiiPlayground {...props} pending result="old result" />)
  expect(view.container.querySelector('[data-phase="running"]')).not.toBeNull()
  expect(view.container.querySelector("output")).toBeNull()
  expect(screen.getByRole("status")).toHaveTextContent("Filtering on your computer")
  view.rerender(<BotPiiPlayground {...props} pending={false} result="[EMAIL]" />)
  expect(view.container.querySelector('[data-phase="complete"]')).not.toBeNull()
  expect(view.container.querySelector("output")).toHaveTextContent("[EMAIL]")
  view.rerender(<BotPiiPlayground {...props} pending={false} error="Could not run filters. Try again." />)
  expect(view.container.querySelector('[data-phase="error"]')).not.toBeNull()
  expect(view.container.querySelector("output")).toBeNull()
  expect(screen.getByRole("alert")).toHaveTextContent("Try again")
  fireEvent.click(screen.getByRole("button", { name: "Run test" }))
  expect(props.onRun).toHaveBeenCalledOnce()
})

it("shows actual matched names as text and distinguishes empty from legacy metadata", () => {
  const props = { value: "sample", onValueChange: vi.fn(), onRun: vi.fn(), pending: false, result: "filtered" }
  const triggeredFilters = [{ id: "one", name: "Email addresses" }, { id: "two", name: "<b>Custom</b>" }]
  const view = render(<BotPiiPlayground {...props} triggeredFilters={triggeredFilters} />)
  expect(screen.getByTestId("pii-triggered-filters")).toHaveTextContent("Matched filters: Email addresses, <b>Custom</b>")
  expect(view.container.querySelector("b")).toBeNull()
  view.rerender(<BotPiiPlayground {...props} triggeredFilters={[]} />)
  expect(screen.getByTestId("pii-triggered-filters")).toHaveTextContent("No filters matched.")
  view.rerender(<BotPiiPlayground {...props} />)
  expect(screen.queryByTestId("pii-triggered-filters")).toBeNull()
  view.rerender(<BotPiiPlayground {...props} triggeredFilters={triggeredFilters} pending />)
  expect(screen.queryByTestId("pii-triggered-filters")).toBeNull()
  view.rerender(<BotPiiPlayground {...props} triggeredFilters={triggeredFilters} error="Failed" />)
  expect(screen.queryByTestId("pii-triggered-filters")).toBeNull()
})
