const base = (process.env.HIVEATTIC_BASE_URL ?? "").replace(/\/$/, "");
const token = process.env.HIVEATTIC_ADMIN_TOKEN ?? "";
const file = process.env.POLICY_FILE || "policy/employers.local.txt";
if (!base || !token) {
  console.error("Set HIVEATTIC_BASE_URL and HIVEATTIC_ADMIN_TOKEN. POLICY_FILE defaults to policy/employers.local.txt.");
  process.exit(2);
}
const text = await import("node:fs").then((fs) => fs.readFileSync(file, "utf8"));
let applied = 0;
for (const line of text.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const [kind, term] = trimmed.split("\t");
  if (!kind || !term) {
    console.error(`Skip line without a tab: ${trimmed}`);
    continue;
  }
  const response = await fetch(`${base}/v1/admin/policy`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ term, kind }),
  });
  if (!response.ok) {
    console.error(`policy ${kind} failed: ${response.status}`);
    process.exit(1);
  }
  applied += 1;
}
console.log(`applied ${applied} terms from ${file}`);
