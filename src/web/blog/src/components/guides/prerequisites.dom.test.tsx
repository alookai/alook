import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/react-dom-harness";
import { Prerequisites } from "./prerequisites";
describe("Tutorial prerequisites", () => {
  it("provides a named region for each tutorial's requirements", () => {
    render(<Prerequisites>Install and sign in to your agents.</Prerequisites>);
    expect(screen.getByRole("complementary", { name: "Before you begin" })).toHaveTextContent("Install and sign in to your agents.");
  });
});
