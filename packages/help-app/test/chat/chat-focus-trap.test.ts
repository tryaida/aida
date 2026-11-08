import { describe, expect, it } from "vitest";
import { focusTrapRedirect } from "../../components/chat/ChatWidget";

// The chat dialog's focus trap (WCAG 2.2 AA): Tab on the last focusable element loops back to
// the first, Shift+Tab on the first loops back to the last, and anything else is left to the
// browser's normal in-page Tab order.

describe("focusTrapRedirect", () => {
  it("wraps Tab forward from the last element to the first", () => {
    expect(focusTrapRedirect("Tab", false, false, true)).toBe("first");
  });

  it("wraps Shift+Tab backward from the first element to the last", () => {
    expect(focusTrapRedirect("Tab", true, true, false)).toBe("last");
  });

  it("leaves interior Tab/Shift+Tab alone (the browser moves focus itself)", () => {
    expect(focusTrapRedirect("Tab", false, false, false)).toBe("none");
    expect(focusTrapRedirect("Tab", true, false, false)).toBe("none");
  });

  it("ignores every key other than Tab", () => {
    expect(focusTrapRedirect("Escape", false, true, true)).toBe("none");
    expect(focusTrapRedirect("Enter", true, true, false)).toBe("none");
  });

  it("forward Tab on the first (but not last) element doesn't wrap", () => {
    expect(focusTrapRedirect("Tab", false, true, false)).toBe("none");
  });

  it("Shift+Tab on the last (but not first) element doesn't wrap", () => {
    expect(focusTrapRedirect("Tab", true, false, true)).toBe("none");
  });

  it("a single focusable element (both first and last) wraps to itself either direction", () => {
    expect(focusTrapRedirect("Tab", false, true, true)).toBe("first");
    expect(focusTrapRedirect("Tab", true, true, true)).toBe("last");
  });
});
