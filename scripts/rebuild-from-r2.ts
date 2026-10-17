const base = (process.env.HIVEATTIC_BASE_URL ?? "").replace(/\/$/, "");
const admin = process.env.HIVEATTIC_ADMIN_TOKEN ?? "";
if (!base || !admin) {
  console.error("Set HIVEATTIC_BASE_URL and HIVEATTIC_ADMIN_TOKEN");
  process.exit(2);
}
const response = await fetch(`${base}/v1/admin/reindex`, {
  method: "POST",
  headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
  body: "{}",
});
const text = await response.text();
process.stdout.write(`${text}\n`);
if (!response.ok) process.exit(1);
