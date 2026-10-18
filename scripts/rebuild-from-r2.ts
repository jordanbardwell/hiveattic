// Starts a rebuild job and polls it until it ends, for at most ten minutes.
const base = (process.env.HIVEATTIC_BASE_URL ?? "").replace(/\/$/, "");
const admin = process.env.HIVEATTIC_ADMIN_TOKEN ?? "";
if (!base || !admin) {
  console.error("Set HIVEATTIC_BASE_URL and HIVEATTIC_ADMIN_TOKEN");
  process.exit(2);
}
const headers = { authorization: `Bearer ${admin}`, "content-type": "application/json" };
const started = await fetch(`${base}/v1/admin/reindex`, { method: "POST", headers, body: "{}" });
const startText = await started.text();
const jobId = (JSON.parse(startText) as { data?: { job_id?: string } }).data?.job_id;
if (started.status !== 202 || !jobId) {
  process.stdout.write(`${startText}\n`);
  process.exit(1);
}
process.stdout.write(`job ${jobId} started\n`);
const stop = Date.now() + 10 * 60 * 1000;
while (Date.now() < stop) {
  const polled = await fetch(`${base}/v1/admin/jobs/${jobId}`, { headers });
  const text = await polled.text();
  const status = (JSON.parse(text) as { data?: { status?: string } }).data?.status;
  if (status === "done" || status === "failed") {
    process.stdout.write(`${text}\n`);
    process.exit(status === "done" ? 0 : 1);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
console.error(`job ${jobId} did not finish within ten minutes`);
process.exit(1);
