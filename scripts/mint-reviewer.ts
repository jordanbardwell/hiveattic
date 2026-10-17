const base = (process.env.HIVEATTIC_BASE_URL ?? "").replace(/\/$/, "");
const admin = process.env.HIVEATTIC_ADMIN_TOKEN ?? "";
const label = process.argv[2] ?? "architect-reviewer";
if (!base || !admin) {
  console.error("Set HIVEATTIC_BASE_URL and HIVEATTIC_ADMIN_TOKEN");
  process.exit(2);
}
const response = await fetch(`${base}/v1/admin/tokens`, {
  method: "POST",
  headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
  body: JSON.stringify({ preset: "reviewer", label }),
});
const body = (await response.json()) as { ok?: boolean; data?: { token?: string; token_id?: string; scopes?: string[] }; error?: { code?: string } };
if (!response.ok || !body.data?.token) {
  console.error(`Mint failed (${response.status} ${body.error?.code ?? ""})`);
  process.exit(1);
}
process.stdout.write(`${body.data.token}\n`);
