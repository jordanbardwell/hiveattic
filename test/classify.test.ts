import { afterEach, describe, expect, it } from "vitest";
import { classificationText, classifyText, frontmatterRoute, journalRouteFor, routeFor } from "../src/classify";
import { configure } from "../src/config";
import { testEnv } from "./helpers";

configure(testEnv());

const route = (text: string, flagged = false, declared: string | null = null) => routeFor(classifyText(text), flagged, declared);

describe("content classification", () => {
  it("routes personal health and finance text to its domain", () => {
    for (const text of ["Got a synthetic flu shot", "New prescription for the migraine", "Saw the dentist", "Blood pressure is high", "Diagnosed with asthma", "MRI on Friday"]) {
      expect(route(text), text).toBe("health");
    }
    for (const text of ["The synthetic budget for October", "Salary review next week", "Mortgage refinance", "Filed the tax return", "401(k) rollover", "Checking account balance is low", "Student loans paid"]) {
      expect(route(text), text).toBe("finance");
    }
  });

  it("sends mixed domains, PII alone, and a bare sensitive flag to restricted", () => {
    expect(route("Hospital bill blew the budget")).toBe("restricted");
    expect(route("Call 206-555-0142 tomorrow")).toBe("restricted");
    expect(route("Lives at 12 Elm Street")).toBe("restricted");
    expect(route("Date of birth is on file")).toBe("restricted");
    expect(route("A plain note", true)).toBe("restricted");
    // One content domain with PII still has a single domain.
    expect(route("Doctor's office is 206-555-0142")).toBe("health");
    // A sensitive domain the caller declared wins.
    expect(route("A plain note", false, "finance")).toBe("finance");
    // An ordinary declared domain cannot lower what the text says.
    expect(route("Flu shot", false, "deals")).toBe("health");
  });

  it("leaves engineering prose, secrets, cards, and employer text where they were written", () => {
    for (const text of [
      "Pay down the tech debt in the parser",
      "We blew the error budget on Tuesday",
      "Diagnose the bug before standup",
      "The symptom is a 500 from the gateway",
      "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      "Card 4242 4242 4242 4242",
      "password: x",
      "Contoso Q3 roadmap for the Qx account team",
      "Account 5839201746 is on file",
      "Ship the release on 2026-10-17",
      "health check endpoint returns 200",
      "Ira joined the call",
      "Run `brew doctor` before the upgrade",
      "flutter doctor --verbose found no issues",
      "scripts/check_env.py doctor returned ok=true",
      "Best used for debugging, tool failure diagnosis, root cause analysis",
      "Error diagnosis took an hour",
    ]) {
      expect(route(text), text).toBeNull();
    }
  });

  it("still routes a person's doctor and diagnosis to health", () => {
    for (const text of [
      "My doctor moved the appointment to Friday",
      "Saw the doctor -- feeling better",
      "The diagnosis came back clean",
      "Doctor's note for school",
      "Ask the doctor about `metformin` dosing",
    ]) {
      expect(route(text), text).toBe("health");
    }
  });

  it("classifies a stored file on its body and caller frontmatter, not on server fields", () => {
    const journal = "---\nvault_id: 01ABC\nsource: budget-bot\nowner: budget-bot\n---\n# 2099-01-01\n\n## 10:00 UTC · budget-bot · standup ^01ARZ3NDEKTSV4RRFFQ69G5FAV\nShipped the parser\n<!-- hiveattic:e=01ARZ3NDEKTSV4RRFFQ69G5FAV:budget-bot:0123456789abcdef -->\n";
    expect(classificationText(journal)).not.toContain("budget-bot");
    expect(frontmatterRoute({ source: "budget-bot" }, journal)).toBeNull();
    expect(frontmatterRoute({ sensitivity: "normal", domain: "deals" }, "---\nsensitivity: normal\ndomain: deals\n---\nFlu shot\n")).toBe("health");
    expect(frontmatterRoute({ sensitivity: "sensitive" }, "---\nsensitivity: sensitive\n---\nplain\n")).toBe("restricted");
    expect(frontmatterRoute({ title: "Dentist" }, "---\ntitle: Dentist\n---\nplain\n")).toBe("health");
  });
});

describe("PII_ROUTE", () => {
  afterEach(() => {
    configure(testEnv());
  });

  it("defaults to restricted", () => {
    configure({ ...testEnv(), PII_ROUTE: undefined });
    expect(route("Call 206-555-0142 tomorrow")).toBe("restricted");
  });

  it("keep leaves PII-only text where it was written and routes everything else as before", () => {
    configure({ ...testEnv(), PII_ROUTE: "keep" });
    expect(route("Call 206-555-0142 tomorrow")).toBeNull();
    expect(route("Lives at 12 Elm Street")).toBeNull();
    expect(route("Date of birth is on file")).toBeNull();
    expect(journalRouteFor(classifyText("Call 206-555-0142 tomorrow"), false, null)).toBeNull();
    // Health and finance, mixed text, the sensitivity flag, and a declared domain do not change.
    expect(route("Doctor's office is 206-555-0142")).toBe("health");
    expect(route("Mortgage payment, call 206-555-0142")).toBe("finance");
    expect(route("Hospital bill blew the budget")).toBe("restricted");
    expect(route("A plain note", true)).toBe("restricted");
    expect(route("Call 206-555-0142", false, "finance")).toBe("finance");
  });

  it("refuses any other value", () => {
    expect(() => configure({ ...testEnv(), PII_ROUTE: "off" })).toThrow(/PII_ROUTE/);
  });
});
