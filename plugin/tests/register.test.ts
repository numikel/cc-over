import { expect, test } from "claude-code/testing";
import { register } from "../hooks/register.js";

test("engine loads the mod and its stub does not intercept events", async ($, on) => {
	// The test's hook sits beneath every plugin; the stub registers nothing,
	// so the result must come from this bottom hook.
	on("classic.SessionStart", () => ({ sessionTitle: "bottom-hook" }));

	const result = await $.classic.SessionStart({ source: "clear" });

	expect(result).toMatchObject({ sessionTitle: "bottom-hook" });
});

test("register is callable with the kit's on", (_$, on) => {
	expect(() => register(on, {})).not.toThrow();
});
